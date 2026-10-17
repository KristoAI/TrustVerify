import express from "express";
import { readFile } from "node:fs/promises";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import geoip from "geoip-lite";
import { ZodError } from "zod";
import { effectiveMethods } from "./domain.mjs";
import { signer } from "./security.mjs";
import { accountRoutes } from "./accounts.mjs";
import { passkeyRoutes } from "./passkeys.mjs";
import { sessionRoutes } from "./sessions.mjs";
import { shell } from "../web/pages.mjs";
import { ensureContinuationDevice } from "./continuation.mjs";
export async function createApp({
  store,
  config,
  geo = (ip) => geoip.lookup(ip),
}) {
  const checkTemplate = await readFile(
    new URL("../web/check.html", import.meta.url),
    "utf8",
  );
  const app = express(),
    signing = await signer(config.keys, config.origin);
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);
  const renderCheckHtml = (js) =>
    checkTemplate
      .replace("__TV_PAGE_CONFIG__", () =>
        JSON.stringify(js)
          .replace(/</g, "\\u003c")
          .replace(/>/g, "\\u003e")
          .replace(/&/g, "\\u0026"),
      )
      .replaceAll("__TV_ASSET_VERSION__", String(Date.now()));
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: "cross-origin" },
      referrerPolicy: { policy: "no-referrer" },
    }),
  );
  app.use((req, res, next) => {
    res.set(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    res.set(
      "Permissions-Policy",
      "camera=(self), microphone=(), geolocation=()",
    );
    if (!req.path.startsWith("/assets/"))
      res.set("Cache-Control", "no-store");
    next();
  });
  // Only the independently built allowlisted assets are public.
  app.use("/assets", express.static("dist/assets", { maxAge: 0 }));
  app.get("/openapi.json", (req, res) =>
    res.sendFile("openapi.json", { root: "public" }),
  );
  app.get("/gate.js", (req, res) =>
    res.sendFile("gate.js", { root: "public" }),
  );
  app.use(
    express.json({ limit: "32kb" }),
    express.urlencoded({ extended: false, limit: "32kb" }),
    cookieParser(),
  );
  app.use(
    ["/api", "/result", "/v1"],
    rateLimit({
      windowMs: 60000,
      limit: 180,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: { error: "Too many requests. Try again in a minute." },
    }),
  );
  app.use(
    ["/api/account", "/api/passkeys", "/api/visitor/recover"],
    rateLimit({
      windowMs: 900000,
      limit: 40,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: { error: "Too many sign-in attempts. Try again later." },
    }),
  );
  app.use((req, res, next) => {
    if (
      ["POST", "PUT", "DELETE", "PATCH"].includes(req.method) &&
      !req.path.startsWith("/v1/")
    ) {
      if (req.get("Origin") !== config.origin)
        return res
          .status(403)
          .json({ error: "Request origin does not match TrustBunny." });
    }
    next();
  });
  const renderApp = (req, res, page) =>
    res.type("html").send(shell(page, config.origin));
  const admin = accountRoutes(app, { store, config });
  passkeyRoutes(app, { store, config });
  const renderCheck = (req, res, session, cap, site) =>
    res.type("html").send(
      renderCheckHtml({
        sessionId: session.id,
        completed: session.status === "completed",
        capability: cap,
        emailExperiment: !!config.email?.enabled && session.environment === "test",
        emailHistoryYears: config.email?.enabled ? config.email.years : undefined,
        methods: effectiveMethods(session.policy),
        initialMethod:
          ["selfie", "document"].includes(req.query.method) &&
          effectiveMethods(session.policy).includes(req.query.method)
            ? req.query.method
            : undefined,
        siteName: site.name,
        branding: site.branding,
        requiredAge: session.min_age,
      }),
    );
  app.get("/continue-phone", (req, res) => {
    ensureContinuationDevice(req, res, config);
    res.type("html").send(renderCheckHtml({ mode: "phone" }));
  });
  sessionRoutes(app, {
    store,
    config,
    signing,
    geo,
    renderApp,
    renderCheck,
    admin,
  });
  app.get("/.well-known/jwks.json", (req, res) => res.json(signing.jwks));
  app.get("/health", (req, res) =>
    res.json({ status: "ok", service: "TrustBunny" }),
  );
  for (const [url, page] of Object.entries({
    "/": "home",
    "/login": "login",
    "/signup": "signup",
    "/recover": "recover",
    "/dashboard": "dashboard",
    "/me": "pass",
    "/complete": "complete",
    "/demo/result": "demo",
    "/docs": "docs",
    "/privacy": "privacy",
    "/terms": "terms",
  }))
    app.get(url, (req, res) => renderApp(req, res, page));
  app.use((req, res) =>
    res.status(404).type("html").send(shell("notfound", config.origin)),
  );
  app.use((err, req, res, next) => {
    const status =
      err.status ||
      (err instanceof ZodError
        ? 400
        : ["23505", "P0001"].includes(err.code)
          ? 409
          : err.code?.startsWith("ERR_JWT") || err.code?.startsWith("ERR_JWS")
            ? 401
            : 500);
    const message =
      err instanceof ZodError
        ? "Check your inputs. " +
          err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
        : status < 500
          ? err.message
          : "Something went wrong. Please try again.";
    if (status >= 500)
      console.error(
        "Request failed:",
        err.name,
        err.code || "",
        err.message?.replace(/https?:\/\/\S+/g, "[URL]"),
      );
    res.status(status).json({ error: message });
  });
  return app;
}
