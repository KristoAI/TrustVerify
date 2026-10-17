import { z } from "zod";
import { createHmac } from "node:crypto";
import { rateLimit } from "express-rate-limit";
import { assert, route, uuid, cookieOptions, readToken, effectiveMethods } from "./domain.mjs";
import { random, hash, equal, seal, unseal } from "./security.mjs";

export const desktopCookie = (id) => `tv_desktop_${id.replaceAll("-", "")}`;
export const phoneCookie = (id) => `tv_phone_${id.replaceAll("-", "")}`;
const secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export function ensureContinuationDevice(req, res, config) {
  if (secret.safeParse(req.cookies.tv_pairing_device).success) return;
  res.cookie("tv_pairing_device", random(), cookieOptions(config, 1800));
}
export function ensureContinuationDesktop(req, res, config, id, supplied) {
  const name = desktopCookie(id);
  const token =
    supplied ||
    (secret.safeParse(req.cookies[name]).success
      ? req.cookies[name]
      : random());
  res.cookie(name, token, cookieOptions(config, 1800));
  return token;
}
const words = [
  "amber",
  "birch",
  "cloud",
  "daisy",
  "elm",
  "fern",
  "glade",
  "harbor",
  "iris",
  "jade",
  "kite",
  "lake",
  "maple",
  "nest",
  "olive",
  "pearl",
];
function pairingPhrase() {
  return [...Buffer.from(random(3), "base64url")]
    .map((b) => words[b & 15])
    .join(" ");
}

// A completion URL alone must never authorize the phone (or another browser).
export function assertDesktopHandoff(req, handoff) {
  if (!handoff.data?.desktop_hash) return;
  assert(
    equal(
      hash(req.cookies[desktopCookie(handoff.owner_id)] || ""),
      handoff.data.desktop_hash,
    ),
    401,
    "Return to the original desktop to receive this result.",
  );
}

export function continuationRoutes(app, { store, config }) {
  app.use(
    "/api/continuation",
    rateLimit({
      windowMs: 60000,
      limit: 90,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
  );
  app.use("/api/continuation", (req, res, next) => {
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    if (req.method !== "GET" && req.get("Origin") !== config.origin)
      return res
        .status(403)
        .json({ error: "Request origin does not match TrustBunny." });
    next();
  });
  const rpc = async (action, args) => {
    try {
      return await store.rpc("tv_continuation", {
        p_action: action,
        p_args: args,
      });
    } catch (error) {
      // Database errors deliberately reveal no hashes, capabilities, or internal state.
      if (["P0001", "22023"].includes(error.code))
        assert(
          false,
          409,
          "This continuation is unavailable or its state changed. Refresh and try again.",
        );
      throw error;
    }
  };
  const credentials = (req, id) => ({
    id,
    desktop_hash: hash(req.cookies[desktopCookie(id)] || ""),
    phone_hash: hash(req.cookies[phoneCookie(id)] || ""),
  });
  const publicStatus = async (row) => {
    const session = await store.one("tv_sessions", { id: row.id });
    const site = await store.one("tv_sites", { id: session.site_id });
    assert(site?.enabled, 410, "This website is unavailable.");
    return {
      id: row.id,
      sessionId: row.id,
      state: row.state,
      expiresAt:
        row.state === "offered"
          ? row.invitation_expires_at
          : row.state === "awaiting_approval"
            ? row.approval_expires_at
            : row.state === "active"
              ? session.expires_at
              : row.expires_at,
      pairingPhrase: ["awaiting_approval", "active"].includes(row.state)
        ? row.pairing_phrase
        : undefined,
      outcome: row.state === "completed" ? session.outcome : undefined,
      methods: effectiveMethods(session.policy),
      requiredAge: session.min_age,
      siteName: site.name,
      branding: site.branding,
      environment: session.environment,
    };
  };
  app.post(
    "/api/continuation/:sessionId/invite",
    route(async (req, res) => {
      const id = uuid.parse(req.params.sessionId);
      const body = z
        .object({ launch: z.string().max(100).optional() })
        .strict()
        .parse(req.body);
      const flow = req.cookies.tv_flow?.split(".");
      const cap = body.launch || (flow?.[0] === id ? flow[1] : "");
      const desktop = req.cookies[desktopCookie(id)];
      assert(
        secret.safeParse(desktop).success,
        401,
        "Reload this verification page before connecting a phone.",
      );
      const invitation = random();
      const visitor = await readToken(store, req.cookies.tv_visitor, "visitor");
      const row = await rpc("invite", {
        id,
        cap_hash: hash(cap),
        desktop_hash: hash(desktop),
        invitation_hash: hash(invitation),
        visitor_id: visitor?.owner_id || null,
      });
      res.cookie(desktopCookie(id), desktop, cookieOptions(config, 1800));
      res.json({
        id,
        url: `${config.origin}/continue-phone#${invitation}`,
        expiresAt: row.invitation_expires_at,
      });
    }),
  );
  app.post(
    "/api/continuation/claim",
    route(async (req, res) => {
      const body = z.object({ invitation: secret }).strict().parse(req.body);
      const existing = await store.one("tv_continuations", {
        invitation_hash: hash(body.invitation),
      });
      assert(existing, 401, "Invitation is invalid or expired.");
      // The landing page establishes this binding before claim. Deriving a
      // capability per invitation makes first-response loss retryable, while a
      // replacement invitation still invalidates the previous generation.
      const device = req.cookies.tv_pairing_device;
      assert(
        secret.safeParse(device).success,
        401,
        "Reload the phone page before connecting.",
      );
      const phone = createHmac("sha256", Buffer.from(config.masterKey, "hex"))
        .update(`${device}:${body.invitation}`)
        .digest("base64url");
      const row = await rpc("claim", {
        id: existing.id,
        invitation_hash: hash(body.invitation),
        phone_hash: hash(phone),
        pairing_phrase: pairingPhrase(),
      });
      res.cookie(phoneCookie(row.id), phone, cookieOptions(config, 1800));
      res.json(await publicStatus(row));
    }),
  );
  app.get(
    "/api/continuation/:id/status",
    route(async (req, res) => {
      res.json(
        await publicStatus(
          await rpc("status", credentials(req, uuid.parse(req.params.id))),
        ),
      );
    }),
  );
  app.post(
    "/api/continuation/:id/approve",
    route(async (req, res) => {
      res.json(
        await publicStatus(
          await rpc("approve", credentials(req, uuid.parse(req.params.id))),
        ),
      );
    }),
  );
  app.post(
    "/api/continuation/:id/cancel",
    route(async (req, res) => {
      const id = uuid.parse(req.params.id),
        cap = random();
      const row = await rpc("cancel", {
        ...credentials(req, id),
        cap_hash: hash(cap),
        launch_cipher: seal(cap, config.masterKey),
      });
      res.cookie("tv_flow", `${id}.${cap}`, cookieOptions(config, 1200));
      res.json({ state: row.state, launch: cap });
    }),
  );
  app.post(
    "/api/continuation/:id/finish",
    route(async (req, res) => {
      const body = z
        .object({
          outcome: z.enum(["success", "fail"]),
          method: z.enum(["selfie", "document"]),
        })
        .strict()
        .parse(req.body);
      const row = await rpc("finish", {
        ...credentials(req, uuid.parse(req.params.id)),
        outcome: body.outcome === "success" ? "passed" : "inconclusive",
        method: body.method,
        proof_token_hash: hash(random()),
      });
      res.json({ state: row.state, outcome: row.outcome });
    }),
  );
  app.post(
    "/api/continuation/:id/complete",
    route(async (req, res) => {
      const id = uuid.parse(req.params.id),
        token = random();
      const row = await rpc("complete", {
        ...credentials(req, id),
        handoff_hash: hash(token),
        handoff_cipher: seal(token, config.masterKey),
      });
      const handoff = unseal(row.handoff_cipher, config.masterKey);
      res.json({
        url: `${config.origin}/complete/${id}?handoff=${encodeURIComponent(handoff)}`,
      });
    }),
  );
}
