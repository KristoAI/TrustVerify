import { z } from "zod";
import { emailRoutes } from "./email.mjs";
import { randomUUID } from "node:crypto";
import {
  continuationRoutes,
  assertDesktopHandoff,
  desktopCookie,
  ensureContinuationDesktop,
} from "./continuation.mjs";
import {
  assert,
  route,
  uuid,
  defaultPolicy,
  effectiveMethods,
  evaluatePolicy,
  proofMeets,
  publicResult,
  createToken,
  readToken,
  cookieOptions,
  cookieProof,
  proofCookie,
} from "./domain.mjs";
import {
  random,
  hash,
  after,
  now,
  isFuture,
  equal,
  seal,
  unseal,
} from "./security.mjs";
const stateSchema = z
  .string()
  .min(22)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);
export function sessionRoutes(
  app,
  { store, config, signing, geo, renderApp, renderCheck, admin },
) {
  continuationRoutes(app, { store, config });
  async function siteById(id) {
    const site = await store.one("tv_sites", {
      id: uuid.parse(id),
      enabled: true,
    });
    assert(site, 404, "Site not found or disabled.");
    // The service-owned demo may predate the brand change.
    if (site.is_demo) site.name = "TrustBunny demo";
    return site;
  }
  async function serviceAuth(req) {
    const raw = req.headers.authorization?.replace(/^Bearer /, "");
    assert(raw, 401, "A server API key is required.");
    const key = await store.one("tv_api_keys", {
      key_hash: hash(raw),
      revoked_at: null,
    });
    assert(key, 401, "API key is invalid or revoked.");
    return siteById(key.site_id);
  }
  async function createSession(site, input, req, idempotencyKey = null) {
    const requestHash = hash(JSON.stringify(input));
    if (idempotencyKey) {
      const previous = await store.one("tv_sessions", {
        site_id: site.id,
        idempotency_key: idempotencyKey,
      });
      if (previous) {
        assert(
          previous.request_hash === requestHash,
          409,
          "Idempotency key was already used with different inputs.",
        );
        assert(
          isFuture(previous.expires_at) && previous.launch_cipher,
          409,
          "The existing session expired. Use a new idempotency key.",
        );
        return {
          session: previous,
          cap: unseal(previous.launch_cipher, config.masterKey),
        };
      }
    }
    const cap = random(),
      id = randomUUID(),
      location = geo(req.ip);
    let session;
    try {
      session = await store.insert("tv_sessions", {
        id,
        site_id: site.id,
        environment: site.environment,
        min_age: site.policy.minAge,
        policy: {
          ...site.policy,
          methods: effectiveMethods(site.policy),
          responseMode: input.response_mode || "assertion",
          codeChallenge: input.code_challenge || null,
        },
        cap_hash: hash(cap),
        launch_cipher: seal(cap, config.masterKey),
        state_nonce: input.state,
        return_url: site.return_url,
        idempotency_key: idempotencyKey,
        request_hash: requestHash,
        country: location?.country || null,
        region: location?.region || null,
        ip_hash: hash(`${config.masterKey}:${req.ip}`),
        expires_at: after(1200),
      });
    } catch (error) {
      // Concurrent retries converge on the row created by the winning request.
      if (error.code === "23505" && idempotencyKey)
        return createSession(site, input, req, idempotencyKey);
      throw error;
    }
    return { session, cap };
  }
  const launchResponse = ({ session, cap }) => ({
    session_id: session.id,
    verification_url: `${config.origin}/v/${session.id}?launch=${encodeURIComponent(cap)}`,
    expires_at: session.expires_at,
    environment: session.environment,
  });
  async function activeSession(id, cap) {
    const session = await store.one("tv_sessions", { id: uuid.parse(id) });
    assert(
      session && equal(session.cap_hash, hash(cap || "")),
      401,
      "Verification link is invalid.",
    );
    assert(
      ["created", "in_progress"].includes(session.status) &&
        isFuture(session.expires_at),
      410,
      "This verification session has finished or expired. Start a new check.",
    );
    return session;
  }
  async function browserSession(req, id, cap) {
    // Completed checks remain recoverable only by their originally bound browser.
    // Result retries additionally validate the submitted cap and SQL outcome.
    const s = await store.one("tv_sessions", { id: uuid.parse(id) });
    if (s?.status === "completed" && req.cookies[desktopCookie(id)]) {
      if (
        isFuture(
          new Date(new Date(s.expires_at).getTime() + 600000).toISOString(),
        ) &&
        equal(s.desktop_hash, hash(req.cookies[desktopCookie(id)]))
      )
        return s;
    }
    return activeSession(id, cap);
  }
  async function browserCap(req, id, supplied) {
    const s = await store.one("tv_sessions", { id: uuid.parse(id) });
    if (
      s?.launch_cipher &&
      equal(s.desktop_hash, hash(req.cookies[desktopCookie(id)] || ""))
    )
      return unseal(s.launch_cipher, config.masterKey);
    return supplied;
  }
  function requireDesktop(req, session) {
    assert(
      equal(
        session.desktop_hash,
        hash(req.cookies[desktopCookie(session.id)] || ""),
      ),
      401,
      "Return to the original browser to finish this check.",
    );
  }
  async function resultSession(req, id, cap) {
    const s = await browserSession(req, id, cap);
    assert(
      equal(s.cap_hash, hash(cap || "")),
      401,
      "Verification link is invalid.",
    );
    requireDesktop(req, s);
    return s;
  }
  emailRoutes(app, { store, config, activeSession, requireDesktop });
  async function getProof(req, site) {
    let proof = await cookieProof(store, req, site.environment);
    if (proofMeets(proof, site.policy, site.environment)) return proof;
    const auth = await readToken(store, req.cookies.tv_visitor, "visitor");
    if (auth) {
      const proofs = await store.find(
        "tv_proofs",
        { visitor_id: auth.owner_id, environment: site.environment },
        { order: "verified_at" },
      );
      proof = proofs.find((p) => proofMeets(p, site.policy, site.environment));
      if (proof) return proof;
    }
    return null;
  }
  async function currentValid(s, site) {
    const proof = s?.proof_id
      ? await store.one("tv_proofs", { id: s.proof_id })
      : null;
    return (
      !!s &&
      s.outcome === "passed" &&
      s.min_age >= site.policy.minAge &&
      isFuture(s.valid_until) &&
      proofMeets(proof, site.policy, site.environment)
    );
  }
  async function complete(
    req,
    res,
    session,
    cap,
    outcome,
    method,
    proofId = null,
  ) {
    requireDesktop(req, session);
    const proofToken = random();
    const result = await store.rpc("tv_finish_session", {
      p_id: session.id,
      p_cap_hash: hash(cap),
      p_outcome: outcome,
      p_method: method,
      p_proof_id: proofId,
      p_proof_token_hash: hash(proofToken),
    });
    if (result.proof_id && !proofId) {
      const auth = await readToken(store, req.cookies.tv_visitor, "visitor");
      if (auth)
        await store.update(
          "tv_proofs",
          { id: result.proof_id, visitor_id: null },
          { visitor_id: auth.owner_id },
        );
    }
    const handoff = await createToken(
      store,
      "completion-handoff",
      session.id,
      { desktop_hash: session.desktop_hash },
      120,
    );
    return {
      handoff,
      url: `${config.origin}/complete/${session.id}?handoff=${handoff}`,
      result,
    };
  }
  app.post(
    "/v1/verification-sessions",
    route(async (req, res) => {
      const site = await serviceAuth(req),
        input = z
          .object({
            state: stateSchema,
            response_mode: z.enum(["assertion", "code"]).default("assertion"),
          })
          .strict()
          .parse(req.body);
      const idempotency = z
        .string()
        .min(8)
        .max(128)
        .parse(req.get("Idempotency-Key"));
      res
        .status(201)
        .json(
          launchResponse(await createSession(site, input, req, idempotency)),
        );
    }),
  );
  app.get(
    "/v1/verification-sessions/:id",
    route(async (req, res) => {
      const site = await serviceAuth(req),
        s = await store.one("tv_sessions", {
          id: uuid.parse(req.params.id),
          site_id: site.id,
        });
      assert(s, 404, "Session not found.");
      const proof = s.proof_id
        ? await store.one("tv_proofs", { id: s.proof_id })
        : null;
      const valid =
        s.outcome === "passed" &&
        s.min_age >= site.policy.minAge &&
        isFuture(s.valid_until) &&
        proofMeets(proof, site.policy, site.environment);
      const deliveries = await store.find("tv_webhooks", { session_id: s.id });
      res.json({
        ...publicResult(s),
        valid,
        delivery_status: deliveries[0]?.status || "not_configured",
      });
    }),
  );
  app.post(
    "/v1/result-exchanges",
    route(async (req, res) => {
      const site = await serviceAuth(req),
        body = z
          .object({ code: z.string().min(20).max(200), state: stateSchema })
          .strict()
          .parse(req.body);
      const record = await readToken(store, body.code, "result-code");
      assert(
        record &&
          record.data.site_id === site.id &&
          record.data.state === body.state,
        401,
        "Invalid result code or state.",
      );
      const token = await store.rpc("tv_consume_token", {
        p_hash: hash(body.code),
        p_kind: "result-code",
      });
      assert(token, 409, "Result code already used.");
      const s = await store.one("tv_sessions", {
        id: token.owner_id,
        site_id: site.id,
      });
      assert(s, 404, "Session not found.");
      res.json({ ...publicResult(s), valid: await currentValid(s, site) });
    }),
  );
  app.use(
    "/v1/browser",
    route(async (req, res, next) => {
      const id = req.query.site_id || req.body?.site_id,
        site = await siteById(id),
        origin = req.get("Origin");
      assert(
        origin === site.origin,
        403,
        "This origin is not registered for the site.",
      );
      req.site = site;
      res.set({
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        Vary: "Origin",
      });
      if (req.method === "OPTIONS") return res.sendStatus(204);
      next();
    }),
  );
  app.post(
    "/v1/browser/bootstrap",
    route(async (req, res) => {
      const body = z
        .object({
          state: stateSchema,
          code_challenge: z.string().regex(/^[0-9a-f]{64}$/),
        })
        .strict()
        .parse(req.body);
      const decision = evaluatePolicy(req.site.policy, geo(req.ip));
      if (decision.decision !== "required")
        return res.json({ ...decision, branding: req.site.branding });
      res.json({
        ...decision,
        ...launchResponse(await createSession(req.site, body, req)),
        branding: req.site.branding,
      });
    }),
  );
  app.post(
    "/v1/browser/receipt",
    route(async (req, res) => {
      const body = z
        .object({
          result: z.string().max(6000),
          verifier: z.string().min(32).max(128),
        })
        .strict()
        .parse(req.body);
      const claims = await signing.verify(body.result, req.site.id);
      const s = await store.one("tv_sessions", {
        id: claims.session_id,
        site_id: req.site.id,
      });
      assert(
        s && equal(s.policy.codeChallenge, hash(body.verifier)),
        401,
        "This result belongs to a different browser session.",
      );
      const proof = s.proof_id
        ? await store.one("tv_proofs", { id: s.proof_id })
        : null;
      assert(
        s.outcome === "passed" &&
          s.min_age >= req.site.policy.minAge &&
          isFuture(s.valid_until) &&
          proofMeets(proof, req.site.policy, req.site.environment),
        403,
        "The result no longer meets the site policy.",
      );
      const receipt = await signing.sign(
        { session_id: s.id, environment: s.environment },
        req.site.id,
        Math.max(1, Math.floor((new Date(s.valid_until) - Date.now()) / 1000)),
        "tv-receipt+jwt",
      );
      res.json({ receipt, valid_until: s.valid_until });
    }),
  );
  app.post(
    "/v1/browser/status",
    route(async (req, res) => {
      const { receipt } = z
          .object({ receipt: z.string().max(6000).optional() })
          .strict()
          .parse(req.body),
        decision = evaluatePolicy(req.site.policy, geo(req.ip));
      let valid = false;
      if (receipt) {
        try {
          const c = await signing.verify(
            receipt,
            req.site.id,
            "tv-receipt+jwt",
          );
          const s = await store.one("tv_sessions", {
            id: c.session_id,
            site_id: req.site.id,
          });
          const p = s?.proof_id
            ? await store.one("tv_proofs", { id: s.proof_id })
            : null;
          valid =
            !!s &&
            s.outcome === "passed" &&
            s.min_age >= req.site.policy.minAge &&
            isFuture(s.valid_until) &&
            proofMeets(p, req.site.policy, req.site.environment);
        } catch {
          valid = false;
        }
      }
      res.json({
        ...decision,
        valid,
        branding: req.site.branding,
        environment: req.site.environment,
      });
    }),
  );
  app.post(
    "/api/dashboard/sites/:id/launch",
    admin.requireAdmin,
    route(async (req, res) => {
      const site = await admin.ownedSite(req, req.params.id);
      res
        .status(201)
        .json(
          launchResponse(await createSession(site, { state: random() }, req)),
        );
    }),
  );
  app.post(
    "/api/demo/start",
    route(async (req, res) => {
      const { mode } = z
        .object({
          mode: z
            .enum(["selfie", "document", "selfie-document"])
            .default("selfie-document"),
        })
        .strict()
        .parse(req.body);
      let site = await store.one("tv_sites", {
        is_demo: true,
        origin: config.origin,
      });
      if (!site)
        site = await store.insert("tv_sites", {
          name: "TrustBunny demo",
          origin: config.origin,
          return_url: `${config.origin}/demo/callback`,
          environment: "test",
          policy: defaultPolicy,
          branding: { color: "#305CFF", title: "Try your age check" },
          is_demo: true,
        });
      const state = await createToken(store, "demo-state", site.id, {}, 1200);
      res.cookie("tv_demo_state", state, cookieOptions(config, 1200));
      // Snapshot the selected policy onto this session. The shared demo site
      // remains unchanged, including while different modes launch concurrently.
      const methods =
        mode === "document" ? ["document"] : ["selfie", "document"];
      const sessionSite = { ...site, policy: { ...site.policy, methods } };
      res.json(
        launchResponse(await createSession(sessionSite, { state }, req)),
      );
    }),
  );
  app.get(
    "/v/:id",
    route(async (req, res) => {
      const flow = req.cookies.tv_flow?.split("."),
        supplied =
          typeof req.query.launch === "string"
            ? req.query.launch
            : flow?.[0] === req.params.id
              ? flow[1]
              : null,
        cap = await browserCap(req, req.params.id, supplied);
      const s = await browserSession(req, req.params.id, cap),
        site = await siteById(s.site_id);
      const currentDesktop = req.cookies[desktopCookie(s.id)];
      const desktop =
        typeof currentDesktop === "string" &&
        /^[A-Za-z0-9_-]{43}$/.test(currentDesktop)
          ? currentDesktop
          : random();
      await store.rpc("tv_bind_desktop", {
        p_id: s.id,
        p_cap_hash: hash(cap),
        p_desktop_hash: hash(desktop),
      });
      ensureContinuationDesktop(req, res, config, s.id, desktop);
      res.cookie("tv_flow", `${s.id}.${cap}`, cookieOptions(config, 1200));
      if (req.query.check === "1") return renderCheck(req, res, s, cap, site);
      renderApp(req, res, "verify");
    }),
  );
  app.get(
    "/api/verification/:id",
    route(async (req, res) => {
      const flow = req.cookies.tv_flow?.split("."),
        supplied =
          req.get("X-TV-Launch") ||
          (flow?.[0] === req.params.id ? flow[1] : null),
        cap = await browserCap(req, req.params.id, supplied);
      const s = await browserSession(req, req.params.id, cap),
        site = await siteById(s.site_id),
        proof = await getProof(req, { ...site, policy: s.policy });
      res.json({
        completed: s.status === "completed",
        session_id: s.id,
        site_name: site.name,
        environment: s.environment,
        min_age: s.min_age,
        methods: effectiveMethods(s.policy),
        branding: site.branding,
        reusable: !!proof,
        verified_at: proof?.verified_at || null,
        check_url: `/v/${s.id}?launch=${encodeURIComponent(cap)}&check=1`,
      });
    }),
  );
  app.post(
    "/api/verification/:id/recover",
    route(async (req, res) => {
      const id = uuid.parse(req.params.id);
      const cap = await browserCap(req, id, req.body?.launch);
      const s = await resultSession(req, id, cap);
      assert(s.status === "completed", 409, "Verification is not complete.");
      const continuation = await store.one("tv_continuations", { id });
      if (continuation?.state === "completed") {
        const token = random();
        const row = await store.rpc("tv_continuation", {
          p_action: "complete",
          p_args: {
            id,
            desktop_hash: hash(req.cookies[desktopCookie(id)]),
            handoff_hash: hash(token),
            handoff_cipher: seal(token, config.masterKey),
          },
        });
        return res.json({
          url: `${config.origin}/complete/${id}?handoff=${encodeURIComponent(unseal(row.handoff_cipher, config.masterKey))}`,
        });
      }
      const done = await complete(
        req,
        res,
        s,
        cap,
        s.outcome,
        s.method,
        s.source === "reused" ? s.proof_id : null,
      );
      res.json({ url: done.url });
    }),
  );
  app.post(
    "/api/verification/:id/reuse",
    route(async (req, res) => {
      const flow = req.cookies.tv_flow?.split("."),
        cap = await browserCap(
          req,
          req.params.id,
          req.body.launch || (flow?.[0] === req.params.id ? flow[1] : null),
        );
      const s = await resultSession(req, req.params.id, cap),
        site = await siteById(s.site_id),
        proof = await getProof(req, { ...site, policy: s.policy });
      assert(
        proof && proofMeets(proof, s.policy, s.environment),
        403,
        "Complete a new age check for this site.",
      );
      const done = await complete(
        req,
        res,
        s,
        cap,
        "passed",
        proof.method,
        proof.id,
      );
      res.json({ url: done.url });
    }),
  );
  // Adapter for the existing browser-only face/OCR engine. All image data stays in-browser.
  app.post(
    "/result/:outcome",
    route(async (req, res) => {
      assert(
        ["success", "fail"].includes(req.params.outcome),
        404,
        "Not found.",
      );
      const body = z
        .object({
          token: z.string().min(20).max(100),
          stepId: z.coerce.number().int(),
          deviceLocationVerification: z.coerce.number().optional(),
          sessionId: uuid,
          idCountry: z.string().max(5).optional().nullable(),
          idState: z.string().max(10).optional().nullable(),
          idType: z.string().max(80).optional().nullable(),
          errorCode: z.coerce.number().optional(),
        })
        .strict()
        .parse(req.body);
      const s = await resultSession(req, body.sessionId, body.token);
      assert(
        [3, 5].includes(body.stepId),
        400,
        "Complete a supported verification step.",
      );
      const method = body.stepId === 3 ? "selfie" : "document",
        done = await complete(
          req,
          res,
          s,
          body.token,
          req.params.outcome === "success" ? "passed" : "inconclusive",
          method,
        );
      res.json({
        content: { successPayload: done.handoff, completionUrl: done.url },
      });
    }),
  );
  app.get(
    "/complete/:id",
    route(async (req, res) => {
      const token = z.string().min(20).max(100).parse(req.query.handoff),
        handoff = await readToken(store, token, "completion-handoff");
      assert(
        handoff?.owner_id === req.params.id,
        401,
        "Completion link expired or already used.",
      );
      assertDesktopHandoff(req, handoff);
      assert(
        await store.rpc("tv_consume_token", {
          p_hash: hash(token),
          p_kind: "completion-handoff",
        }),
        409,
        "Completion already received.",
      );
      const session = await store.one("tv_sessions", { id: req.params.id });
      assert(session, 404, "Session not found.");
      if (session.proof_id) {
        const proof = await store.one("tv_proofs", { id: session.proof_id });
        assert(
          proof && !proof.revoked_at && isFuture(proof.expires_at),
          410,
          "Saved verification has expired.",
        );
        const seconds = Math.max(
          1,
          Math.floor((new Date(proof.expires_at) - Date.now()) / 1000),
        );
        const alias = await createToken(
          store,
          "proof-access",
          proof.id,
          {},
          seconds,
        );
        res.cookie(
          proofCookie(proof.environment),
          alias,
          cookieOptions(config, seconds),
        );
      }
      const view = await createToken(
        store,
        "completion-view",
        session.id,
        {},
        1200,
      );
      res.cookie("tv_completion", view, cookieOptions(config, 1200));
      res.redirect(303, "/complete");
    }),
  );
  app.get(
    "/api/completion",
    route(async (req, res) => {
      const view = await readToken(
        store,
        req.cookies.tv_completion,
        "completion-view",
      );
      assert(view, 401, "Complete a verification first.");
      const s = await store.one("tv_sessions", { id: view.owner_id }),
        site = await siteById(s.site_id);
      res.json({ ...publicResult(s), site_name: site.name });
    }),
  );
  app.post(
    "/api/completion/continue",
    route(async (req, res) => {
      const view = await readToken(
        store,
        req.cookies.tv_completion,
        "completion-view",
      );
      assert(view, 401, "Completion expired. Start again.");
      const s = await store.one("tv_sessions", { id: view.owner_id }),
        site = await siteById(s.site_id);
      assert(s.status === "completed", 409, "Verification is not complete.");
      if (s.outcome === "passed")
        assert(
          await currentValid(s, site),
          410,
          "This result expired, was revoked, or no longer meets the site policy. Start a new check.",
        );
      const url = new URL(s.return_url);
      if (s.policy.responseMode === "code") {
        url.searchParams.set(
          "tv_code",
          await createToken(
            store,
            "result-code",
            s.id,
            { site_id: site.id, state: s.state_nonce },
            120,
          ),
        );
      } else {
        url.searchParams.set(
          "tv_result",
          await signing.sign(
            {
              ...publicResult(s),
              nonce: s.state_nonce,
              policy_version: s.policy.version,
            },
            site.id,
          ),
        );
      }
      url.searchParams.set("state", s.state_nonce);
      res.json({ url: url.href });
    }),
  );
  app.get(
    "/demo/callback",
    route(async (req, res) => {
      const state = req.cookies.tv_demo_state;
      assert(
        state && equal(state, req.query.state),
        401,
        "Demo browser session did not match.",
      );
      const pending = await readToken(store, state, "demo-state");
      assert(pending, 401, "Demo callback already used or expired.");
      const claims = await signing.verify(
        z.string().max(6000).parse(req.query.tv_result),
        pending.owner_id,
      );
      assert(
        claims.nonce === state && claims.environment === "test",
        401,
        "Demo result did not match.",
      );
      assert(
        await store.rpc("tv_consume_token", {
          p_hash: hash(state),
          p_kind: "demo-state",
        }),
        409,
        "Demo callback already used.",
      );
      const t = await createToken(
        store,
        "demo-result",
        claims.session_id,
        {},
        3600,
      );
      res.cookie("tv_demo_result", t, cookieOptions(config, 3600));
      res.clearCookie("tv_demo_state", cookieOptions(config, 0));
      res.redirect(303, "/demo/result");
    }),
  );
  app.get(
    "/api/demo/result",
    route(async (req, res) => {
      const t = await readToken(
        store,
        req.cookies.tv_demo_result,
        "demo-result",
      );
      assert(t, 404, "Run the demo to see a result.");
      const s = await store.one("tv_sessions", { id: t.owner_id });
      res.json(publicResult(s));
    }),
  );
}
