import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  makeSigningKeys,
  signer,
  seal,
  unseal,
  hash,
  passwordHash,
  passwordMatches,
  isPublicIP,
  allowedReturn,
  webhookTarget,
  webhookSignature,
  after,
} from "../server/security.mjs";
import {
  defaultPolicy,
  policySchema,
  effectiveMethods,
  evaluatePolicy,
  proofMeets,
  publicResult,
} from "../server/domain.mjs";
import { runDeliveries } from "../server/worker.mjs";
test("JWT signature, issuer, audience, token type, and expiry are enforced", async () => {
  const keys = await makeSigningKeys(),
    a = await signer(keys, "https://verify.example"),
    other = await signer(await makeSigningKeys(), "https://verify.example");
  const jwt = await a.sign({ session_id: "session" }, "site");
  assert.equal((await a.verify(jwt, "site")).session_id, "session");
  await assert.rejects(a.verify(jwt, "another-site"));
  await assert.rejects(a.verify(jwt, "site", "tv-receipt+jwt"));
  await assert.rejects(other.verify(jwt, "site"));
  await assert.rejects(
    (await signer(keys, "https://other.example")).verify(jwt, "site"),
  );
  await assert.rejects(a.verify(await a.sign({}, "site", -1), "site"));
});
test("encrypted secrets reject modification and wrong keys", () => {
  const key = crypto.randomBytes(32).toString("hex"),
    v = seal("webhook-secret", key);
  assert.equal(unseal(v, key), "webhook-secret");
  assert.throws(() => unseal(v, crypto.randomBytes(32).toString("hex")));
  const b = Buffer.from(v, "base64url");
  b[13] ^= 1;
  assert.throws(() => unseal(b.toString("base64url"), key));
});
test("passwords use independent salts and reject wrong inputs", async () => {
  const a = await passwordHash("long-test-password"),
    b = await passwordHash("long-test-password");
  assert.notEqual(a, b);
  assert(await passwordMatches("long-test-password", a));
  assert.equal(await passwordMatches("wrong-password", a), false);
});
test("redirect allowlist rejects foreign origins, query strings, and insecure live sites", () => {
  assert.equal(
    allowedReturn(
      "http://localhost:9000/callback",
      "http://localhost:9000",
      "test",
    ),
    "http://localhost:9000/callback",
  );
  for (const [url, origin, env] of [
    ["https://evil.example/cb", "https://site.example", "live"],
    ["https://site.example/cb?next=evil", "https://site.example", "live"],
    ["http://site.example/cb", "http://site.example", "live"],
    ["https://user:password@site.example/cb", "https://site.example", "live"],
  ])
    assert.throws(() => allowedReturn(url, origin, env));
});
test("webhooks block private, reserved, mixed DNS, metadata, and redirects by construction", async () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "192.168.1.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "192.0.2.1",
  ])
    assert.equal(isPublicIP(ip), false, ip);
  assert.equal(isPublicIP("8.8.8.8"), true);
  const publicDNS = async () => [{ address: "8.8.8.8", family: 4 }];
  assert.equal(
    (await webhookTarget("https://example.com/hooks", publicDNS)).address
      .address,
    "8.8.8.8",
  );
  for (const url of [
    "http://example.com",
    "https://example.com:444",
    "https://user:pass@example.com",
    "https://example.com/?secret=x",
  ])
    await assert.rejects(webhookTarget(url, publicDNS));
  await assert.rejects(
    webhookTarget("https://example.com", async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]),
  );
});
test("location and proof reuse follow each client policy", () => {
  const p = { ...defaultPolicy, mode: "regions", regions: ["US-TX", "GB"] };
  assert.equal(
    evaluatePolicy(p, { country: "US", region: "TX" }).decision,
    "required",
  );
  assert.equal(
    evaluatePolicy(p, { country: "US", region: "NY" }).decision,
    "not_required",
  );
  assert.equal(evaluatePolicy(p, { country: "GB" }).decision, "required");
  for (const [unknown, want] of [
    ["require", "required"],
    ["allow", "not_required"],
    ["deny", "denied"],
  ])
    assert.equal(evaluatePolicy({ ...p, unknown }, null).decision, want);
  const proof = {
    min_age: 21,
    environment: "live",
    method: "document",
    verified_at: after(-3600),
    expires_at: after(10000),
  };
  assert(proofMeets(proof, defaultPolicy, "live"));
  assert(!proofMeets(proof, defaultPolicy, "test"));
  assert(
    !proofMeets({ ...proof, revoked_at: after(0) }, defaultPolicy, "live"),
  );
  assert(
    !proofMeets({ ...proof, expires_at: after(-1) }, defaultPolicy, "live"),
  );
  assert(!proofMeets(proof, { ...defaultPolicy, minAge: 25 }, "live"));
  assert(!proofMeets(proof, { ...defaultPolicy, maxAgeHours: 1 }, "live"));
  assert(proofMeets(proof, { ...defaultPolicy, methods: ["selfie"] }, "live"));
});
test("public results never expose root visitor or capability information", () => {
  const result = publicResult({
    id: "a",
    site_id: "b",
    status: "created",
    expires_at: after(-1),
    visitor_id: "secret",
    proof_id: "root",
    cap_hash: "secret",
    state_nonce: "secret",
    ip_hash: "secret",
    environment: "test",
    min_age: 18,
  });
  assert.equal(result.status, "expired");
  for (const key of [
    "visitor_id",
    "proof_id",
    "cap_hash",
    "ip_hash",
    "state_nonce",
  ])
    assert.equal(key in result, false);
});
test("webhook worker signs exact bytes, leases updates, retries failures, and terminates exhausted jobs", async () => {
  const masterKey = crypto.randomBytes(32).toString("hex"),
    secret = "test-secret",
    updates = [],
    job = {
      id: "event",
      session_id: "session",
      site_id: "site",
      event_type: "verification.completed",
      created_at: after(-1),
      payload: { outcome: "passed" },
      attempts: 1,
      lease_until: after(90),
    },
    store = {
      rpc: async () => [job],
      one: async () => ({
        enabled: true,
        webhook_url: "https://receiver.example/hook",
        webhook_secret: seal(secret, masterKey),
      }),
      update: async (table, where, data) => {
        updates.push({ where, data });
        return [data];
      },
    };
  await runDeliveries(store, { masterKey }, async (url, body, signature) => {
    assert.equal(JSON.parse(body).id, "event");
    const t = Number(signature.match(/t=(\d+)/)[1]);
    assert.equal(signature, webhookSignature(body, secret, t));
    return 204;
  });
  assert.equal(updates[0].data.status, "delivered");
  assert.equal(updates[0].where.lease_until, job.lease_until);
  await runDeliveries(store, { masterKey }, async () => 503);
  assert.equal(updates[1].data.status, "pending");
  assert.equal(updates[1].data.error_code, "http_503");
  job.attempts = 12;
  await runDeliveries(store, { masterKey }, async () => {
    throw new Error("network");
  });
  assert.equal(updates[2].data.status, "failed");
});

test("Live AI policies always allow document reinforcement without changing legacy snapshots", () => {
  const legacy = { ...defaultPolicy, methods: ["selfie"] };
  assert.deepEqual(effectiveMethods(legacy), ["selfie", "document"]);
  assert.deepEqual(policySchema.parse(legacy).methods, ["selfie", "document"]);
  assert.deepEqual(legacy.methods, ["selfie"]);
  const proof = {
    method: "document", min_age: 18, environment: "test",
    expires_at: after(3600), verified_at: after(-60),
  };
  assert.equal(proofMeets(proof, legacy, "test"), true);
  const documentOnly = { ...defaultPolicy, methods: ["document"] };
  assert.deepEqual(policySchema.parse(documentOnly).methods, ["document"]);
  assert.equal(proofMeets({ ...proof, method: "selfie" }, documentOnly, "test"), false);
});
