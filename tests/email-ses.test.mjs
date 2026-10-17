import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import {
  createEmailHandler,
  dispatchDigest,
  sameSecret,
  signSesRequest,
  validPayload,
} from "../supabase/functions/trustbunny-email/email.mjs";

const config = {
  secret: "test-edge-secret-".repeat(3),
  region: "us-east-1",
  accessKeyId: "AKIDEXAMPLE000000",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  from: "verify@example.com",
};
const payload = {
  requestId: "11111111-2222-4333-8444-555555555555",
  to: "recipient@example.com",
  code: "123456",
};
const request = (body = payload, headers = {}) =>
  new Request("https://edge.example.test", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-tv-email-key": config.secret,
      ...headers,
    },
    body: JSON.stringify(body),
  });

test("SES signing matches an independent Node crypto Signature V4 calculation", async () => {
  const signed = await signSesRequest(
    config,
    payload,
    new Date("2026-09-20T12:34:56Z"),
  );
  assert.equal(
    signed.url,
    "https://email.us-east-1.amazonaws.com/v2/email/outbound-emails",
  );
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const canonical = `POST\n/v2/email/outbound-emails\n\ncontent-type:application/json\nhost:email.us-east-1.amazonaws.com\nx-amz-date:20260920T123456Z\n\ncontent-type;host;x-amz-date\n${hash(signed.body)}`;
  let key = Buffer.from(`AWS4${config.secretAccessKey}`);
  for (const value of ["20260920", "us-east-1", "ses", "aws4_request"])
    key = createHmac("sha256", key).update(value).digest();
  const signature = createHmac("sha256", key)
    .update(
      `AWS4-HMAC-SHA256\n20260920T123456Z\n20260920/us-east-1/ses/aws4_request\n${hash(canonical)}`,
    )
    .digest("hex");
  assert.equal(
    signed.headers.authorization,
    `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/20260920/us-east-1/ses/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=${signature}`,
  );
  const body = JSON.parse(signed.body);
  assert.deepEqual(body.Destination, { ToAddresses: [payload.to] });
  assert.match(body.Content.Simple.Body.Text.Data, /123456/);
  assert.equal(body.FromEmailAddress, config.from);
});

test("temporary AWS credentials are signed, with a fixed configuration set and China endpoint", async () => {
  const signed = await signSesRequest(
    {
      ...config,
      region: "cn-north-1",
      sessionToken: "temporary-token",
      configurationSet: "transactional",
    },
    payload,
    new Date("2026-09-20T12:34:56Z"),
  );
  assert.equal(
    signed.url,
    "https://email.cn-north-1.amazonaws.com.cn/v2/email/outbound-emails",
  );
  assert.equal(signed.headers["x-amz-security-token"], "temporary-token");
  assert.match(
    signed.headers.authorization,
    /SignedHeaders=content-type;host;x-amz-date;x-amz-security-token/,
  );
  assert.equal(JSON.parse(signed.body).ConfigurationSetName, "transactional");
});

test("payload accepts only a UUID, one recipient and six-digit code", () => {
  assert.ok(validPayload(payload));
  for (const changed of [
    { subject: "arbitrary" },
    { code: "<script>" },
    { requestId: "not-id" },
    { to: "victim@example.com\r\nBcc: attacker@example.com" },
    { to: "a@example.com,b@example.com" },
    { to: "a..b@example.com" },
    { to: "a@-domain.com" },
    { to: "a@localhost" },
  ]) {
    assert.ok(!validPayload({ ...payload, ...changed }));
  }
});

test("shared-secret authentication rejects weak configuration and mismatches", async () => {
  assert.equal(await sameSecret(config.secret, config.secret), true);
  assert.equal(await sameSecret(config.secret + "x", config.secret), false);
  assert.equal(await sameSecret("short", "short"), false);
  assert.equal(await sameSecret("x".repeat(300), config.secret), false);
});

test("authenticated dispatch binds its one-time DB claim to all payload fields", async () => {
  const calls = [];
  let claimed = false;
  const handler = createEmailHandler({
    config,
    claim: async (id, digest) => {
      calls.push(["claim", id, digest]);
      if (claimed) return { ok: false };
      claimed = true;
      return { ok: true };
    },
    fetchImpl: async (url, options) => {
      calls.push(["send", url, options]);
      return new Response('{"MessageId":"accepted"}');
    },
    finish: async (...args) => {
      calls.push(["finish", ...args]);
    },
  });
  const response = await handler(request());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { accepted: true });
  assert.deepEqual(calls[0], [
    "claim",
    payload.requestId,
    createHash("sha256")
      .update(`${payload.requestId}\n${payload.to}\n${payload.code}`)
      .digest("hex"),
  ]);
  assert.deepEqual(calls[2], ["finish", payload.requestId, true]);
  assert.equal(calls[1][2].redirect, "error");
  assert.equal((await handler(request())).status, 409);
  assert.equal(calls.filter(([action]) => action === "send").length, 1);
  for (const changed of [
    { requestId: "22222222-2222-4333-8444-555555555555" },
    { to: "another@example.com" },
    { code: "654321" },
  ]) {
    assert.notEqual(
      await dispatchDigest(payload),
      await dispatchDigest({ ...payload, ...changed }),
    );
  }
});

test("unauthenticated, malformed and oversized requests never claim or send", async () => {
  const forbidden = async () => assert.fail("unexpected side effect");
  const handler = createEmailHandler({
    config,
    claim: forbidden,
    finish: forbidden,
    fetchImpl: forbidden,
  });
  assert.equal(
    (await handler(request(payload, { "x-tv-email-key": "invalid" }))).status,
    401,
  );
  assert.equal(
    (await handler(request({ ...payload, arbitrary: true }))).status,
    400,
  );
  assert.equal(
    (await handler(request({ ...payload, to: "x".repeat(3000) }))).status,
    413,
  );
  assert.equal(
    (await handler(request(payload, { "content-type": "text/plain" }))).status,
    400,
  );
  assert.equal(
    (await handler(new Request("https://edge.example.test", { method: "GET" })))
      .status,
    405,
  );
  const unavailable = createEmailHandler({
    config: { ...config, secret: "short" },
    claim: forbidden,
    finish: forbidden,
    fetchImpl: forbidden,
  });
  assert.equal((await unavailable(request())).status, 503);
});

test("denied or failed DB claims never contact SES", async () => {
  for (const claim of [
    async () => ({ ok: false }),
    async () => {
      throw new Error("private database detail");
    },
  ]) {
    const handler = createEmailHandler({
      config,
      claim,
      finish: async () => assert.fail("must not finalize"),
      fetchImpl: async () => assert.fail("must not send"),
    });
    const response = await handler(request());
    assert.ok([409, 503].includes(response.status));
    assert.doesNotMatch(await response.text(), /private/);
  }
});

test("SES rejection and network uncertainty are sanitized and never automatically retried", async () => {
  for (const provider of [
    async () =>
      new Response(`private ${payload.to} ${payload.code}`, { status: 400 }),
    async () => {
      throw new Error(`private ${payload.to} ${payload.code}`);
    },
  ]) {
    let sends = 0;
    const finished = [];
    const handler = createEmailHandler({
      config,
      claim: async () => ({ ok: true }),
      fetchImpl: async (...args) => {
        sends++;
        return provider(...args);
      },
      finish: async (...args) => finished.push(args),
    });
    const response = await handler(request());
    assert.equal(response.status, 502);
    assert.equal(sends, 1);
    assert.deepEqual(finished, [[payload.requestId, false]]);
    assert.doesNotMatch(await response.text(), /private|recipient|123456/);
  }
});

test("accepted SES dispatch with unavailable state persistence returns uncertainty without resending", async () => {
  let sends = 0;
  const handler = createEmailHandler({
    config,
    claim: async () => ({ ok: true }),
    fetchImpl: async () => {
      sends++;
      return new Response("{}");
    },
    finish: async () => {
      throw new Error("private");
    },
  });
  assert.equal((await handler(request())).status, 503);
  assert.equal(sends, 1);
});
