import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createApp } from "../server/app.mjs";
import { makeSigningKeys, hash, random } from "../server/security.mjs";
import { createPreviewStore } from "../script/preview-store.mjs";

async function serve(t, store) {
  const config = {
    origin: "http://127.0.0.1",
    secure: false,
    trustProxy: false,
    keys: await makeSigningKeys(),
    masterKey: "a".repeat(64),
  };
  const app = await createApp({ store, config, geo: () => null });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  config.origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return (token) =>
    fetch(`${config.origin}/api/visitor/forget`, {
      method: "POST",
      headers: {
        Origin: config.origin,
        "Content-Type": "application/json",
        ...(token ? { Cookie: `tv_proof_test=${token}` } : {}),
      },
      body: "{}",
    });
}

test("failed revocation preserves proof cookies so retry can revoke the same proof", async (t) => {
  const id = randomUUID(),
    token = random(),
    calls = [];
  let fail = true;
  const request = await serve(t, {
    async one(table, where) {
      return table === "tv_proofs" && where.token_hash === hash(token)
        ? { id }
        : null;
    },
    async rpc(name, args) {
      calls.push({ name, args });
      if (fail)
        throw Object.assign(new Error("Temporary database failure"), {
          code: "P0001",
        });
      return 1;
    },
  });
  const failure = await request(token);
  assert.equal(failure.status, 409);
  assert.equal(failure.headers.get("set-cookie"), null);
  fail = false;
  const success = await request(token);
  assert.equal(success.status, 200);
  assert.deepEqual(await success.json(), { ok: true });
  assert.match(success.headers.get("set-cookie"), /tv_proof_test=;/);
  assert.match(success.headers.get("set-cookie"), /tv_proof=;/);
  assert.deepEqual(calls[0], {
    name: "tv_forget_proofs",
    args: { p_visitor_id: null, p_proof_ids: [id] },
  });
  assert.deepEqual(calls[1], calls[0]);
});

const container = process.env.TV_PREVIEW_TEST_CONTAINER;
test(
  "preview HTTP revocation handles empty and populated UUID arrays and invalidates saved results",
  { skip: !container },
  async (t) => {
    const store = createPreviewStore(container);
    const proofId = randomUUID(),
      unrelatedId = randomUUID(),
      siteId = randomUUID(),
      sessionId = randomUUID();
    const token = random();
    t.after(async () => {
      await store.remove("tv_sites", { id: siteId });
      await store.remove("tv_proofs", { id: proofId });
      await store.remove("tv_proofs", { id: unrelatedId });
    });
    const request = await serve(t, store);
    const empty = await request();
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { ok: true });
    const tomorrow = new Date(Date.now() + 86400000).toISOString();
    for (const [id, value] of [
      [proofId, token],
      [unrelatedId, random()],
    ]) {
      await store.insert("tv_proofs", {
        id,
        token_hash: hash(value),
        min_age: 18,
        environment: "test",
        method: "selfie",
        expires_at: tomorrow,
      });
    }
    await store.insert("tv_sites", {
      id: siteId,
      name: "Revocation regression fixture",
      origin: "https://example.test",
      return_url: "https://example.test/result",
      environment: "test",
      policy: { methods: ["selfie"] },
      webhook_url: "https://example.test/webhook",
    });
    await store.insert("tv_sessions", {
      id: sessionId,
      site_id: siteId,
      status: "completed",
      outcome: "passed",
      environment: "test",
      min_age: 18,
      policy: {},
      cap_hash: hash(random()),
      state_nonce: random(),
      return_url: "https://example.test/result",
      expires_at: tomorrow,
      proof_id: proofId,
      valid_until: tomorrow,
    });
    const response = await request(token);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.ok((await store.one("tv_proofs", { id: proofId })).revoked_at);
    assert.equal(
      (await store.one("tv_proofs", { id: unrelatedId })).revoked_at,
      null,
    );
    assert.ok(
      new Date(
        (await store.one("tv_sessions", { id: sessionId })).valid_until,
      ) <= new Date(),
    );
    const events = await store.find("tv_webhooks", { session_id: sessionId });
    assert.equal(events.length, 1);
    assert.equal(events[0].event_type, "verification.revoked");
    assert.equal(events[0].payload.valid, false);
    assert.equal((await request(token)).status, 200);
    assert.equal(
      (await store.find("tv_webhooks", { session_id: sessionId })).length,
      1,
    );
  },
);
