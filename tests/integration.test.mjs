import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Encoder } from "cbor-x";
const encoder = new Encoder({ useRecords: false, useTag259ForMaps: false });
const encode = (value) => Buffer.from(encoder.encode(value));
import { loadConfig } from "../server/config.mjs";
import { SupabaseStore } from "../server/store.mjs";
import { createApp } from "../server/app.mjs";
import { defaultPolicy } from "../server/domain.mjs";
import { hash, random, after, signer } from "../server/security.mjs";
const enabled = process.env.TV_INTEGRATION_TEST === "1";
test(
  "real Supabase journeys and security boundaries",
  { skip: !enabled, timeout: 240000 },
  async (t) => {
    const base = await loadConfig(),
      config = {
        ...base,
        origin: "http://127.0.0.1:3311",
        rpID: "127.0.0.1",
        secure: false,
        trustProxy: false,
      },
      store = new SupabaseStore(config.store),
      app = await createApp({ store, config, geo: () => null }),
      server = app.listen(3311, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const accounts = [],
      sites = [],
      visitors = [],
      sessionIds = [],
      proofIds = new Set(),
      ownerIds = new Set();
    function client() {
      const cookies = new Map();
      return {
        cookies,
        async req(
          path,
          {
            body,
            method,
            headers = {},
            status = 200,
            origin = config.origin,
          } = {},
        ) {
          const r = await fetch(config.origin + path, {
            method: method || (body ? "POST" : "GET"),
            redirect: "manual",
            headers: {
              ...(body ? { "Content-Type": "application/json" } : {}),
              Origin: origin,
              Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
              ...headers,
            },
            body: body ? JSON.stringify(body) : undefined,
          });
          for (const c of r.headers.getSetCookie()) {
            const [kv] = c.split(";"),
              i = kv.indexOf("=");
            cookies.set(kv.slice(0, i), kv.slice(i + 1));
          }
          const text = await r.text();
          let data;
          try {
            data = JSON.parse(text);
          } catch {
            data = text;
          }
          assert.equal(
            r.status,
            status,
            `${method || "request"} ${path.split("?")[0]}: ${JSON.stringify(data).slice(0, 300)}`,
          );
          return { data, r };
        },
      };
    }
    const admin = client(),
      visitor = client(),
      another = client(),
      suffix = random(8);
    let site,
      key,
      otherSite,
      otherKey,
      account,
      recovery,
      launch,
      cap,
      result,
      assertion,
      authCredential;
    const create = async (skey, input = {}, status = 201) => {
      const res = await visitor.req("/v1/verification-sessions", {
        body: { state: random(), ...input },
        headers: {
          Authorization: `Bearer ${skey}`,
          "Idempotency-Key": random(),
        },
        status,
      });
      if (status === 201) {
        sessionIds.push(res.data.session_id);
        ownerIds.add(res.data.session_id);
      }
      return res.data;
    };
    const finish = async (l, client_ = visitor, step = 3) => {
      const page = new URL(l.verification_url);
      await client_.req(page.pathname + page.search);
      const c = page.searchParams.get("launch");
      const { data } = await client_.req("/result/success", {
        body: {
          token: c,
          stepId: step,
          sessionId: l.session_id,
          deviceLocationVerification: 0,
        },
      });
      const s = await store.one("tv_sessions", { id: l.session_id });
      proofIds.add(s.proof_id);
      return data.content;
    };
    try {
      await t.test("anonymous database bridge access is denied", async () => {
        const r = await fetch(config.store.url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.store.anonKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ op: "select", table: "tv_accounts" }),
        });
        assert.equal(r.status, 401);
      });
      await t.test(
        "business registration, CSRF, dashboard isolation and site creation",
        async () => {
          await admin.req("/api/account/register", {
            body: {
              name: "Integration fixture",
              email: `test-${suffix}@example.test`,
              password: "A-test-password-123!",
            },
            origin: "https://evil.example",
            status: 403,
          });
          const r = await admin.req("/api/account/register", {
            body: {
              name: "Integration fixture",
              email: `test-${suffix}@example.test`,
              password: "A-test-password-123!",
            },
            status: 201,
          });
          account = r.data.account;
          recovery = r.data.recovery_code;
          accounts.push(account.id);
          ownerIds.add(account.id);
          assert(recovery);
          assert.match(r.r.headers.get("set-cookie"), /HttpOnly/);
          assert.match(r.r.headers.get("set-cookie"), /SameSite=Lax/);
          await another.req("/api/dashboard", { status: 401 });
          assert.equal(
            (await admin.req("/api/dashboard")).data.sites.length,
            0,
          );
          const data = {
            name: "Integration test site",
            origin: config.origin,
            return_url: config.origin + "/fixture/callback",
            environment: "test",
            policy: defaultPolicy,
            branding: { color: "#345cfa", title: "Confirm your age" },
          };
          const first = await admin.req("/api/dashboard/sites", {
            body: data,
            status: 201,
          });
          site = first.data.site;
          key = first.data.api_key;
          sites.push(site.id);
          ownerIds.add(site.id);
          const second = await admin.req("/api/dashboard/sites", {
            body: { ...data, name: "Second tenant boundary" },
            status: 201,
          });
          otherSite = second.data.site;
          otherKey = second.data.api_key;
          sites.push(otherSite.id);
          ownerIds.add(otherSite.id);
          const dashboard = (await admin.req("/api/dashboard")).data;
          assert.equal(dashboard.sites.length, 2);
          assert(!JSON.stringify(dashboard).includes(key));
          assert(!("key_hash" in dashboard.keys[0]));
        },
      );
      await t.test(
        "idempotency, wrong capabilities, data minimization and site isolation",
        async () => {
          const state = random(),
            headers = {
              Authorization: `Bearer ${key}`,
              "Idempotency-Key": random(),
            };
          launch = (
            await visitor.req("/v1/verification-sessions", {
              body: { state },
              headers,
              status: 201,
            })
          ).data;
          sessionIds.push(launch.session_id);
          ownerIds.add(launch.session_id);
          cap = new URL(launch.verification_url).searchParams.get("launch");
          const launchPage = new URL(launch.verification_url);
          await visitor.req(launchPage.pathname + launchPage.search);
          const repeat = (
            await visitor.req("/v1/verification-sessions", {
              body: { state },
              headers,
              status: 201,
            })
          ).data;
          assert.equal(repeat.verification_url, launch.verification_url);
          await visitor.req("/v1/verification-sessions", {
            body: { state: random() },
            headers,
            status: 409,
          });
          await visitor.req("/v1/verification-sessions/" + launch.session_id, {
            headers: { Authorization: `Bearer ${otherKey}` },
            status: 404,
          });
          await visitor.req("/result/success", {
            body: {
              token: random(),
              stepId: 3,
              sessionId: launch.session_id,
              deviceLocationVerification: 0,
            },
            status: 401,
          });
          await visitor.req("/result/success", {
            body: {
              token: cap,
              stepId: 3,
              sessionId: launch.session_id,
              image: "do-not-store",
            },
            status: 400,
          });
          await visitor.req("/result/success", {
            body: { token: cap, stepId: 1, sessionId: launch.session_id },
            status: 400,
          });
        },
      );
      await t.test(
        "concurrent creation, safe page configuration, and dashboard tenant isolation",
        async () => {
          const state = random(),
            headers = {
              Authorization: `Bearer ${key}`,
              "Idempotency-Key": random(),
            };
          const results = await Promise.all(
            [1, 2, 3].map(() =>
              visitor.req("/v1/verification-sessions", {
                body: { state },
                headers,
                status: 201,
              }),
            ),
          );
          assert.equal(new Set(results.map((r) => r.data.session_id)).size, 1);
          const l = results[0].data;
          sessionIds.push(l.session_id);
          ownerIds.add(l.session_id);
          const url = new URL(l.verification_url),
            agent = '</script><script src="/untrusted.js"></script>';
          const html = (
            await visitor.req(url.pathname + url.search + "&check=1", {
              headers: { "User-Agent": agent },
            })
          ).data;
          assert(!html.includes(agent));
          assert(!html.includes("__TV_PAGE_CONFIG__"));
          assert(html.includes("TrustBunny"));
          const json = html.match(
            /<script\b[^>]*id="verification-config"[^>]*>([\s\S]*?)<\/script>/,
          )[1];
          assert.equal(JSON.parse(json).sessionId, l.session_id);
          assert.equal(
            JSON.parse(json).capability,
            url.searchParams.get("launch"),
          );
          assert.equal(JSON.parse(json).deviceInfo, undefined);
          const stranger = client(),
            r = await stranger.req("/api/account/register", {
              body: {
                name: "Other tenant fixture",
                email: `other-${suffix}@example.test`,
                password: "Other-fixture-password!",
              },
              status: 201,
            });
          accounts.push(r.data.account.id);
          ownerIds.add(r.data.account.id);
          assert.equal(
            (await stranger.req("/api/dashboard")).data.sites.length,
            0,
          );
          await stranger.req(`/api/dashboard/sites/${site.id}/keys`, {
            body: { name: "Forbidden key" },
            status: 404,
          });
        },
      );
      await t.test(
        "browser result, one-time completion, signed redirect and current session API",
        async () => {
          result = await finish(launch);
          await visitor.req("/result/success", {
            body: { token: cap, stepId: 3, sessionId: launch.session_id },
            status: 200,
          });
          const handoff = new URL(result.completionUrl);
          await visitor.req(handoff.pathname + handoff.search, { status: 303 });
          await visitor.req(handoff.pathname + handoff.search, { status: 401 });
          assert(visitor.cookies.get("tv_proof_test"));
          const completed = (await visitor.req("/api/completion")).data;
          assert.equal(completed.outcome, "passed");
          assert.equal(completed.assurance, "browser_asserted");
          assert.equal(completed.age_over, 18);
          const redirect = (
            await visitor.req("/api/completion/continue", { body: {} })
          ).data.url;
          assertion = new URL(redirect).searchParams.get("tv_result");
          const signing = await signer(config.keys, config.origin),
            claims = await signing.verify(assertion, site.id);
          assert.equal(claims.session_id, launch.session_id);
          assert.equal(claims.environment, "test");
          assert.equal(
            claims.nonce,
            new URL(redirect).searchParams.get("state"),
          );
          assert(!("proof_id" in claims));
          const current = (
            await visitor.req(
              "/v1/verification-sessions/" + launch.session_id,
              { headers: { Authorization: `Bearer ${key}` } },
            )
          ).data;
          assert.equal(current.valid, true);
        },
      );
      await t.test(
        "cross-site reuse preserves original proof time and isolates test/live",
        async () => {
          const next = await create(otherKey);
          await visitor.req(
            new URL(next.verification_url).pathname +
              new URL(next.verification_url).search,
          );
          const info = (
            await visitor.req("/api/verification/" + next.session_id)
          ).data;
          assert.equal(info.reusable, true);
          const reused = (
            await visitor.req(`/api/verification/${next.session_id}/reuse`, {
              body: {},
            })
          ).data;
          assert(reused.url);
          const old = await store.one("tv_sessions", { id: launch.session_id }),
            newer = await store.one("tv_sessions", { id: next.session_id });
          assert.equal(newer.proof_id, old.proof_id);
          assert.equal(newer.verified_at, old.verified_at);
          const live = await admin.req("/api/dashboard/sites", {
            body: {
              name: "Live boundary",
              origin: "https://example.test",
              return_url: "https://example.test/cb",
              environment: "live",
              policy: defaultPolicy,
              branding: { color: "#345cfa", title: "Live check" },
            },
            status: 201,
          });
          sites.push(live.data.site.id);
          ownerIds.add(live.data.site.id);
          const l = await create(live.data.api_key);
          await visitor.req(
            new URL(l.verification_url).pathname +
              new URL(l.verification_url).search,
          );
          assert.equal(
            (await visitor.req("/api/verification/" + l.session_id)).data
              .reusable,
            false,
          );
        },
      );
      await t.test(
        "discoverable passkey registration and authentication verify real cryptography",
        async () => {
          const opts = (
            await visitor.req("/api/passkeys/register/options", { body: {} })
          ).data;
          assert.equal(opts.authenticatorSelection.residentKey, "required");
          assert.equal(
            opts.authenticatorSelection.userVerification,
            "required",
          );
          const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
              namedCurve: "prime256v1",
            }),
            jwk = publicKey.export({ format: "jwk" }),
            id = crypto.randomBytes(32),
            cose = encode(
              new Map([
                [1, 2],
                [3, -7],
                [-1, 1],
                [-2, Buffer.from(jwk.x, "base64url")],
                [-3, Buffer.from(jwk.y, "base64url")],
              ]),
            );
          const rpHash = crypto
              .createHash("sha256")
              .update(config.rpID)
              .digest(),
            len = Buffer.alloc(2);
          len.writeUInt16BE(id.length);
          const authData = Buffer.concat([
            rpHash,
            Buffer.from([0x45]),
            Buffer.alloc(4),
            Buffer.alloc(16),
            len,
            id,
            cose,
          ]);
          const clientData = Buffer.from(
            JSON.stringify({
              type: "webauthn.create",
              challenge: opts.challenge,
              origin: config.origin,
              crossOrigin: false,
            }),
          );
          const response = {
            id: id.toString("base64url"),
            rawId: id.toString("base64url"),
            type: "public-key",
            response: {
              clientDataJSON: clientData.toString("base64url"),
              attestationObject: encode(
                new Map([
                  ["fmt", "none"],
                  ["attStmt", new Map()],
                  ["authData", authData],
                ]),
              ).toString("base64url"),
              transports: ["internal"],
            },
            clientExtensionResults: {},
          };
          const registration = await visitor.req(
            "/api/passkeys/register/verify",
            { body: response },
          );
          assert(registration.data.recovery_code);
          await visitor.req("/api/passkeys/register/verify", {
            body: response,
            status: 401,
          });
          const saved = await store.one("tv_passkeys", { id: response.id });
          visitors.push(saved.visitor_id);
          ownerIds.add(saved.visitor_id);
          assert(saved.public_key);
          authCredential = {
            id: response.id,
            privateKey,
            rpHash,
            userHandle: opts.user.id,
          };
          const login = async (
            client_,
            origin = config.origin,
            status = 200,
          ) => {
            const options = (
                await client_.req("/api/passkeys/login/options", { body: {} })
              ).data,
              cd = Buffer.from(
                JSON.stringify({
                  type: "webauthn.get",
                  challenge: options.challenge,
                  origin,
                  crossOrigin: false,
                }),
              ),
              ad = Buffer.concat([
                rpHash,
                Buffer.from([5]),
                Buffer.from([0, 0, 0, 1]),
              ]),
              sig = crypto.sign(
                "sha256",
                Buffer.concat([
                  ad,
                  crypto.createHash("sha256").update(cd).digest(),
                ]),
                privateKey,
              );
            return client_.req("/api/passkeys/login/verify", {
              body: {
                id: response.id,
                rawId: response.id,
                type: "public-key",
                response: {
                  clientDataJSON: cd.toString("base64url"),
                  authenticatorData: ad.toString("base64url"),
                  signature: sig.toString("base64url"),
                  userHandle: opts.user.id,
                },
                clientExtensionResults: {},
              },
              status,
            });
          };
          await login(another);
          assert.equal(
            (await another.req("/api/visitor")).data.signed_in,
            true,
          );
          assert.equal(
            (await another.req("/api/visitor")).data.proofs[0].age_over,
            18,
          );
          const noCookie = await create(key);
          await another.req(
            new URL(noCookie.verification_url).pathname +
              new URL(noCookie.verification_url).search,
          );
          assert.equal(
            (await another.req("/api/verification/" + noCookie.session_id)).data
              .reusable,
            true,
          );
        },
      );
      await t.test(
        "browser CORS, geographic fallback, receipt binding and revocation",
        async () => {
          const verifier = random(),
            state = random();
          await visitor.req("/v1/browser/status?site_id=" + site.id, {
            body: {},
            origin: "https://evil.example",
            status: 403,
          });
          const boot = (
            await visitor.req("/v1/browser/bootstrap?site_id=" + site.id, {
              body: { state, code_challenge: hash(verifier) },
            })
          ).data;
          sessionIds.push(boot.session_id);
          ownerIds.add(boot.session_id);
          assert.equal(boot.decision, "required");
          const done = await finish(boot),
            u = new URL(done.completionUrl);
          await visitor.req(u.pathname + u.search, { status: 303 });
          const redirect = new URL(
              (await visitor.req("/api/completion/continue", { body: {} })).data
                .url,
            ),
            token = redirect.searchParams.get("tv_result");
          await visitor.req("/v1/browser/receipt?site_id=" + site.id, {
            body: { result: token, verifier: random() },
            status: 401,
          });
          const receipt = (
            await visitor.req("/v1/browser/receipt?site_id=" + site.id, {
              body: { result: token, verifier },
            })
          ).data.receipt;
          assert.equal(
            (
              await visitor.req("/v1/browser/status?site_id=" + site.id, {
                body: { receipt },
              })
            ).data.valid,
            true,
          );
          await admin.req(
            "/api/dashboard/sessions/" + boot.session_id + "/revoke",
            { body: {} },
          );
          assert.equal(
            (
              await visitor.req("/v1/browser/status?site_id=" + site.id, {
                body: { receipt },
              })
            ).data.valid,
            false,
          );
          const freshSite = await store.one("tv_sites", { id: site.id });
          await admin.req("/api/dashboard/sites/" + site.id, {
            method: "PUT",
            body: {
              name: site.name,
              origin: site.origin,
              return_url: site.return_url,
              environment: "test",
              policy: {
                ...defaultPolicy,
                mode: "regions",
                regions: ["US-TX"],
                unknown: "deny",
              },
              branding: site.branding,
              webhook_url: null,
              enabled: true,
            },
          });
          assert.equal(
            (
              await visitor.req("/v1/browser/status?site_id=" + site.id, {
                body: {},
              })
            ).data.decision,
            "denied",
          );
          await store.update(
            "tv_sites",
            { id: site.id },
            { policy: freshSite.policy },
          );
        },
      );
      await t.test(
        "code exchange is site-bound, state-bound, and single-use",
        async () => {
          const state = random(),
            l = await create(key, { response_mode: "code", state }),
            done = await finish(l),
            u = new URL(done.completionUrl);
          await visitor.req(u.pathname + u.search, { status: 303 });
          const redirect = new URL(
              (await visitor.req("/api/completion/continue", { body: {} })).data
                .url,
            ),
            code = redirect.searchParams.get("tv_code");
          await visitor.req("/v1/result-exchanges", {
            body: { code, state: random() },
            headers: { Authorization: `Bearer ${key}` },
            status: 401,
          });
          await visitor.req("/v1/result-exchanges", {
            body: { code, state },
            headers: { Authorization: `Bearer ${otherKey}` },
            status: 401,
          });
          const exchanged = (
            await visitor.req("/v1/result-exchanges", {
              body: { code, state },
              headers: { Authorization: `Bearer ${key}` },
            })
          ).data;
          assert.equal(exchanged.session_id, l.session_id);
          await visitor.req("/v1/result-exchanges", {
            body: { code, state },
            headers: { Authorization: `Bearer ${key}` },
            status: 401,
          });
        },
      );
      await t.test(
        "atomic completion outbox, pass forgetting, and expired session rejection",
        async () => {
          // Reserved documentation IP: the delivery worker refuses it without sending a request.
          await store.update(
            "tv_sites",
            { id: site.id },
            { webhook_url: "https://192.0.2.1/fixture" },
          );
          const l = await create(key),
            done = await finish(l),
            u = new URL(done.completionUrl);
          await visitor.req(u.pathname + u.search, { status: 303 });
          const events = await store.find("tv_webhooks", {
            session_id: l.session_id,
          });
          assert.equal(events.length, 1);
          assert.equal(events[0].event_type, "verification.completed");
          assert.equal(events[0].payload.assurance, "browser_asserted");
          assert(!("proof_id" in events[0].payload));
          await visitor.req("/api/visitor/forget", { body: {} });
          const current = (
            await visitor.req("/v1/verification-sessions/" + l.session_id, {
              headers: { Authorization: `Bearer ${key}` },
            })
          ).data;
          assert.equal(current.valid, false);
          assert(
            (
              await store.find("tv_webhooks", { session_id: l.session_id })
            ).some((e) => e.event_type === "verification.revoked"),
          );
          await visitor.req("/api/completion/continue", {
            body: {},
            status: 410,
          });
          await store.update(
            "tv_sites",
            { id: site.id },
            { webhook_url: null },
          );
          const expired = await create(key);
          await store.update(
            "tv_sessions",
            { id: expired.session_id },
            { expires_at: after(-1) },
          );
          await visitor.req("/result/success", {
            body: {
              sessionId: expired.session_id,
              stepId: 3,
              token: new URL(expired.verification_url).searchParams.get(
                "launch",
              ),
            },
            status: 410,
          });
        },
      );
      await t.test(
        "recovery rotates codes, invalidates old admin sessions and API key revocation works",
        async () => {
          const outsider = client();
          await outsider.req("/api/account/recover", {
            body: {
              email: account.email,
              password: "Replacement-password-123!",
              recovery_code: recovery,
            },
          });
          await admin.req("/api/dashboard", { status: 401 });
          await outsider.req("/api/account/recover", {
            body: {
              email: account.email,
              password: "Replacement-password-123!",
              recovery_code: recovery,
            },
            status: 401,
          });
          const keys = (await outsider.req("/api/dashboard")).data.keys,
            old = keys.find((k) => k.site_id === site.id);
          await outsider.req("/api/dashboard/keys/" + old.id, {
            method: "DELETE",
            body: {},
          });
          await create(key, {}, 401);
        },
      );
    } finally {
      for (const id of sites) {
        const ss = await store.find("tv_sessions", { site_id: id });
        for (const s of ss) {
          ownerIds.add(s.id);
          if (s.proof_id) proofIds.add(s.proof_id);
        }
      }
      for (const id of proofIds) ownerIds.add(id);
      for (const id of ownerIds)
        await store.remove("tv_tokens", { owner_id: id });
      for (const id of accounts) await store.remove("tv_accounts", { id });
      for (const id of proofIds) await store.remove("tv_proofs", { id });
      for (const id of visitors) await store.remove("tv_visitors", { id });
      await new Promise((r) => server.close(r));
    }
  },
);
