import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { createApp } from "../server/app.mjs";
import {
  after,
  hash,
  random,
  seal,
  unseal,
  makeSigningKeys,
} from "../server/security.mjs";
import { desktopCookie } from "../server/continuation.mjs";
import { createPreviewStore } from "../script/preview-store.mjs";
import {
  emailConfig,
  privateHash,
  runEmailJobs,
  sendEmailAtEdge,
} from "../server/email.mjs";
import { createEmailHandler } from "../supabase/functions/trustbunny-email/email.mjs";

const container = process.env.TV_PREVIEW_TEST_CONTAINER;
test("email config defaults off and enforces sender settings when enabled", () => {
  assert.deepEqual(emailConfig({}), { enabled: false });
  assert.throws(() => emailConfig({ TV_EMAIL_EXPERIMENT: "true" }));
  const env = {
    TV_EMAIL_EXPERIMENT: "true",
    TV_EMAIL_EDGE_URL: "https://example.test/edge",
    TV_EMAIL_EDGE_SECRET: "s".repeat(32),
  };
  assert.equal(emailConfig(env).years, 10);
  for (const value of ["0", "NaN", "100"])
    assert.throws(() => emailConfig({ ...env, TV_EMAIL_HISTORY_YEARS: value }));
  assert.throws(() =>
    emailConfig({ ...env, TV_EMAIL_EDGE_URL: "http://example.test/edge" }),
  );
  assert.throws(() =>
    emailConfig({ ...env, TV_EMAIL_EDGE_SECRET: "s".repeat(257) }),
  );
});

test(
  "email experiment: HTTP, durable worker, authenticated edge and OTP; no age proof",
  { skip: !container },
  async (t) => {
    const store = createPreviewStore(container);
    const action = (p_action, p_id = null, p_data = {}) =>
      store.rpc("tv_email_action", { p_action, p_id, p_data });
    const siteId = randomUUID(),
      cap = random(),
      desktop = random(),
      sessionId = randomUUID();
    const config = {
      origin: "http://127.0.0.1",
      secure: false,
      trustProxy: false,
      masterKey: randomBytes(32).toString("hex"),
      keys: await makeSigningKeys(),
      email: {
        enabled: true,
        years: 10,
        edgeUrl: "https://example.test/edge",
        edgeSecret: "s".repeat(32),
      },
    };
    const site = {
      id: siteId,
      name: "Email experiment fixture",
      origin: "https://example.test",
      return_url: "https://example.test/return",
      environment: "test",
      policy: {
        methods: ["selfie", "document"],
        minAge: 18,
        maxAgeHours: 8760,
      },
    };
    await store.insert("tv_sites", site);
    t.after(async () => {
      await store.remove("tv_sites", { id: siteId });
    });
    await store.insert("tv_sessions", {
      id: sessionId,
      site_id: siteId,
      environment: "test",
      min_age: 18,
      cap_hash: hash(cap),
      desktop_hash: hash(desktop),
      policy: site.policy,
      state_nonce: random(),
      return_url: site.return_url,
      expires_at: after(1200),
    });
    const app = await createApp({ store, config, geo: () => null });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    config.origin = `http://127.0.0.1:${server.address().port}`;
    const base = `/api/verification/${sessionId}/email`;
    const request = async (path, body, cookie = true) =>
      fetch(config.origin + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Origin: config.origin,
          "Content-Type": "application/json",
          ...(cookie
            ? { Cookie: `${desktopCookie(sessionId)}=${desktop}` }
            : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const email = `fixture-${randomUUID()}@example.test`;
    assert.equal(
      (await request(base, { capability: cap, email, consent: true }, false))
        .status,
      401,
    );
    assert.equal(
      (await request(base, { capability: cap, email, consent: false })).status,
      400,
    );
    assert.equal(
      (
        await request(base, {
          capability: "x".repeat(32),
          email,
          consent: true,
        })
      ).status,
      401,
    );
    const started = await request(base, {
      capability: cap,
      email,
      consent: true,
    });
    assert.equal(started.status, 202);
    const created = await started.json();
    assert.equal(created.status, "queued");
    const row = await store.one("tv_email_checks", { id: created.id });
    assert.equal(row.minimum_years, 10);
    assert.equal(unseal(row.email_cipher, config.masterKey), email);
    assert.notEqual(row.email_hash, hash(email));
    assert.deepEqual(
      await (
        await request(base, { capability: cap, email, consent: true })
      ).json(),
      created,
    );
    assert.equal(
      (await request(`${base}/${created.id}/send`, { capability: cap })).status,
      409,
    );
    let catalogs = 0,
      lookups = 0,
      sends = 0,
      otp;
    const edge = createEmailHandler({
      config: {
        secret: config.email.edgeSecret,
        from: "verify@example.test",
        region: "us-east-1",
        accessKeyId: "AKIAEXAMPLE0000000000",
        secretAccessKey: "s".repeat(40),
      },
      claim: (id, payloadHash) => action("dispatch", id, { payloadHash }),
      finish: async (id, accepted) => {
        const result = await action(accepted ? "sent" : "send_failed", id);
        assert.equal(result.status, accepted ? "sent" : "unavailable");
      },
      fetchImpl: async () => {
        sends++;
        return new Response("{}", { status: 200 });
      },
    });
    const deps = {
      catalog: async () => {
        catalogs++;
        return [{ id: "synthetic", date: "2000-01-01" }];
      },
      lookup: async (value, catalog, years) => {
        lookups++;
        assert.equal(value, email);
        assert.equal(years, 10);
        return true;
      },
      send: async (job) => {
        otp = unseal(job.code_cipher, config.masterKey);
        await sendEmailAtEdge(job, config, (url, opts) =>
          edge(new Request(url, opts)),
        );
      },
    };
    const originalCatalog = await store.one("tv_email_catalog", { id: 1 });
    t.after(() => store.update("tv_email_catalog", { id: 1 }, originalCatalog));
    // Synthetic catalog stays confined to this test and is restored afterward.
    await action("catalog_save", null, {
      catalog: [{ id: "synthetic", date: "2000-01-01" }],
    });
    await runEmailJobs(store, config, deps);
    const status = () =>
      request(`${base}/${created.id}?capability=${cap}`).then((r) => r.json());
    assert.deepEqual(await status(), { id: created.id, status: "eligible" });
    assert.equal(lookups, 1);
    assert.equal(catalogs, 0);
    assert.equal(sends, 0);
    const send = await request(`${base}/${created.id}/send`, {
      capability: cap,
    });
    assert.equal(send.status, 200);
    await Promise.all([
      runEmailJobs(store, config, deps),
      runEmailJobs(store, config, deps),
    ]);
    assert.equal(sends, 1);
    assert.equal((await status()).status, "sent");
    const sent = await store.one("tv_email_checks", { id: created.id });
    assert.equal(sent.email_cipher, null);
    assert.equal(sent.code_cipher, null);
    assert.match(otp, /^\d{6}$/);
    assert.equal(
      (await request(`${base}/${created.id}/send`, { capability: cap })).status,
      200,
    );
    await runEmailJobs(store, config, deps);
    assert.equal(sends, 1);
    const wrong = otp === "000000" ? "999999" : "000000";
    assert.equal(
      (
        await (
          await request(`${base}/${created.id}/verify`, {
            capability: cap,
            code: wrong,
          })
        ).json()
      ).status,
      "sent",
    );
    const verified = await request(`${base}/${created.id}/verify`, {
      capability: cap,
      code: otp,
    });
    assert.equal((await verified.json()).status, "verified");
    assert.equal(
      (
        await request(`${base}/${created.id}/verify`, {
          capability: cap,
          code: otp,
        })
      ).status,
      409,
    );
    const completed = await store.one("tv_sessions", { id: sessionId });
    assert.notEqual(completed.status, "completed");
    assert.equal(completed.proof_id, null);
    assert.equal(
      (await store.one("tv_email_checks", { id: created.id })).code_hash,
      null,
    );
    await store.update(
      "tv_sessions",
      { id: sessionId },
      { environment: "live" },
    );
    assert.equal(
      (await request(`${base}/${created.id}?capability=${cap}`)).status,
      403,
    );
  },
);

test(
  "durable OTP lockout, expiration, dispatch binding and rolling quota concurrency",
  { skip: !container },
  async (t) => {
    const store = createPreviewStore(container),
      siteId = randomUUID();
    const action = (p_action, p_id = null, p_data = {}) =>
      store.rpc("tv_email_action", { p_action, p_id, p_data });
    await store.insert("tv_sites", {
      id: siteId,
      name: "Email atomic fixture",
      origin: "https://example.test",
      return_url: "https://example.test/return",
      environment: "test",
      policy: { methods: ["document"] },
    });
    t.after(() => store.remove("tv_sites", { id: siteId }));
    async function fixture(status, fields = {}) {
      const sid = randomUUID(),
        id = randomUUID();
      await store.insert("tv_sessions", {
        id: sid,
        site_id: siteId,
        environment: "test",
        min_age: 18,
        cap_hash: hash(random()),
        policy: { methods: ["document"] },
        state_nonce: random(),
        return_url: "https://example.test/return",
        expires_at: after(1200),
      });
      return store.insert("tv_email_checks", {
        id,
        session_id: sid,
        status,
        email_hash: hash(random()),
        minimum_years: 10,
        expires_at: after(1200),
        code_expires_at: after(600),
        code_hash: "correct-hmac",
        ...fields,
      });
    }
    const locked = await fixture("sent");
    const guesses = await Promise.all(
      Array.from({ length: 10 }, () =>
        action("verify", locked.id, { code_hash: "wrong" }),
      ),
    );
    assert.equal(guesses.filter((x) => x.status === "sent").length, 4);
    assert.equal(
      (await store.one("tv_email_checks", { id: locked.id })).attempts,
      5,
    );
    assert.ok(
      (await action("verify", locked.id, { code_hash: "correct-hmac" })).error,
    );
    const expired = await fixture("sent", { code_expires_at: after(-1) });
    assert.ok(
      (await action("verify", expired.id, { code_hash: "correct-hmac" })).error,
    );
    await action("cleanup");
    assert.equal(
      (await store.one("tv_email_checks", { id: expired.id })).status,
      "expired",
    );
    const pending = await fixture("send_requested", {
      payload_hash: "approved",
    });
    assert.ok(
      (await action("dispatch", pending.id, { payloadHash: "forged" })).error,
    );
    const budget = `test:${randomUUID()}`;
    t.after(() => store.remove("tv_email_budget", { bucket: budget }));
    const allowed = await Promise.all(
      Array.from({ length: 8 }, () =>
        store.rpc("tv_email_reserve", {
          p_bucket: budget,
          p_second: 2,
          p_hour: 25,
          p_day: 100,
        }),
      ),
    );
    assert.equal(allowed.filter(Boolean).length, 2);
    for (const [suffix, count, seconds] of [
      ["hour", 25, -60],
      ["day", 100, -7200],
    ]) {
      const bucket = `${budget}:${suffix}`;
      t.after(() => store.remove("tv_email_budget", { bucket }));
      // Old reservations still count after a worker restart; no in-memory state.
      await Promise.all(
        Array.from({ length: count }, () =>
          store.insert("tv_email_budget", { bucket, at: after(seconds) }),
        ),
      );
      assert.equal(
        await store.rpc("tv_email_reserve", {
          p_bucket: bucket,
          p_second: 2,
          p_hour: 25,
          p_day: 100,
        }),
        false,
      );
    }
    const paused = await fixture("queued");
    await store.update(
      "tv_sessions",
      { id: paused.session_id },
      { status: "completed" },
    );
    assert.equal(await action("claim"), null);
    const metrics = await action("metrics");
    assert.ok(metrics.usage);
    assert.equal(JSON.stringify(metrics).includes("email_hash"), false);
  },
);
