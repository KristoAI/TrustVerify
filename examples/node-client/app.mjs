// Reference client: in-memory app sessions are intentional for this local example.
import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";
import crypto from "node:crypto";
const app = express(),
  origin = process.env.TV_EXAMPLE_ISSUER || "http://localhost:3300",
  key = process.env.TV_EXAMPLE_API_KEY,
  environment = process.env.TV_EXAMPLE_ENVIRONMENT || "test",
  port = Number(process.env.TV_EXAMPLE_PORT || 4400),
  sessions = new Map(),
  events = new Map();
if (!key) throw new Error("Set TV_EXAMPLE_API_KEY to a test site server key.");
const random = () => crypto.randomBytes(32).toString("base64url"),
  safe = (a, b) =>
    typeof a === "string" &&
    typeof b === "string" &&
    a.length === b.length &&
    crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const tv = async (path, body, extra = {}) => {
  const r = await fetch(origin + path, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${key}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...extra,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || "TrustBunny unavailable");
  return d;
};
app.use((req, res, next) => {
  res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  next();
});
app.post(
  ["/webhooks/trustbunny", "/webhooks/trustverify"],
  express.raw({ type: "application/json", limit: "32kb" }),
  (req, res) => {
    const secret = process.env.TV_EXAMPLE_WEBHOOK_SECRET;
    if (!secret) return res.sendStatus(503);
    const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(
      req.get("TrustBunny-Signature") || req.get("TrustVerify-Signature") || "",
    );
    if (!match || Math.abs(Date.now() / 1000 - Number(match[1])) > 300)
      return res.sendStatus(401);
    const expected = crypto
      .createHmac("sha256", secret)
      .update(match[1] + ".")
      .update(req.body)
      .digest("hex");
    if (!safe(expected, match[2])) return res.sendStatus(401);
    let event;
    try {
      event = JSON.parse(req.body);
    } catch {
      return res.sendStatus(400);
    }
    if (
      !event.id ||
      !event.data?.session_id ||
      event.data.environment !== environment
    )
      return res.sendStatus(400);
    if (events.has(event.id)) return res.sendStatus(204);
    events.set(event.id, Date.now());
    if (event.type === "verification.revoked")
      for (const session of sessions.values())
        if (session.remoteId === event.data.session_id) session.remoteId = null;
    res.sendStatus(204);
  },
);
app.use(cookieParser());
app.use((req, res, next) => {
  let id = req.cookies.example_session,
    session = sessions.get(id);
  if (!session || session.expires < Date.now()) {
    id = random();
    session = { expires: Date.now() + 3600000 };
    sessions.set(id, session);
    res.cookie("example_session", id, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.TV_EXAMPLE_HTTPS === "1",
      path: "/",
      maxAge: 3600000,
    });
  }
  req.example = session;
  next();
});
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
app.get("/", (req, res) =>
  res
    .type("html")
    .send(
      '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>TrustBunny reference client</title><body style="font:16px Arial;max-width:650px;margin:80px auto;padding:24px"><h1>A server-protected age gate.</h1><p>This example stores the verification session ID on its own server and checks current validity before serving restricted content.</p><p><a href="/start">Start verification</a> · <a href="/protected">Open protected content</a></p></body></html>',
    ),
);
app.get(
  "/start",
  wrap(async (req, res) => {
    const state = random();
    req.example.state = state;
    req.example.pendingUntil = Date.now() + 1200000;
    const session = await tv(
      "/v1/verification-sessions",
      { state, response_mode: "code" },
      { "Idempotency-Key": random() },
    );
    req.example.pendingId = session.session_id;
    res.redirect(303, session.verification_url);
  }),
);
app.get(
  "/callback",
  wrap(async (req, res) => {
    if (
      !safe(req.query.state, req.example.state) ||
      req.example.pendingUntil < Date.now() ||
      typeof req.query.tv_code !== "string"
    )
      return res
        .status(401)
        .send("Verification state did not match this browser. Start again.");
    const state = req.example.state;
    delete req.example.state;
    const data = await tv("/v1/result-exchanges", {
      code: req.query.tv_code,
      state,
    });
    if (
      data.session_id !== req.example.pendingId ||
      data.environment !== environment ||
      data.outcome !== "passed" ||
      data.valid !== true ||
      data.age_over < 18
    )
      return res.status(403).send("The age check did not pass.");
    req.example.remoteId = data.session_id;
    res.redirect(303, "/protected");
  }),
);
app.get(
  "/protected",
  wrap(async (req, res) => {
    if (!req.example.remoteId) return res.redirect(303, "/");
    const data = await tv(
      "/v1/verification-sessions/" + encodeURIComponent(req.example.remoteId),
    );
    if (
      data.valid !== true ||
      data.environment !== environment ||
      data.age_over < 18
    ) {
      delete req.example.remoteId;
      return res
        .status(403)
        .send(
          "This age check is no longer valid. Return to the homepage and verify again.",
        );
    }
    res
      .type("html")
      .send(
        '<!doctype html><html lang="en"><title>Protected content</title><body style="font:16px Arial;max-width:650px;margin:80px auto;padding:24px"><h1>You’re in.</h1><p>This response was served only after an authenticated session API check. No visitor image, date of birth, or email was needed.</p><a href="/">Return home</a></body></html>',
      );
  }),
);
app.use((error, req, res, next) =>
  res
    .status(503)
    .send(
      "Verification is temporarily unavailable. Return to the homepage and try again.",
    ),
);
setInterval(() => {
  for (const [id, s] of sessions)
    if (s.expires < Date.now()) sessions.delete(id);
  for (const [id, time] of events)
    if (time < Date.now() - 86400000) events.delete(id);
}, 60000).unref();
app.listen(port, "localhost", () =>
  console.log(`Reference client: http://localhost:${port}`),
);
