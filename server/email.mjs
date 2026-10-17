import { createHmac, randomInt, randomUUID } from "node:crypto";
import { z } from "zod";
import { assert, route, uuid } from "./domain.mjs";
import { hash, seal, unseal } from "./security.mjs";
import { fetchBreachCatalog, checkEmailHistory } from "./email-provider.mjs";

export function emailConfig(env = process.env) {
  if (env.TV_EMAIL_EXPERIMENT !== "true") return { enabled: false };
  const years = Number(env.TV_EMAIL_HISTORY_YEARS || 10);
  assert(
    Number.isInteger(years) && years >= 1 && years <= 99,
    500,
    "Invalid TV_EMAIL_HISTORY_YEARS.",
  );
  let url;
  try {
    url = new URL(env.TV_EMAIL_EDGE_URL);
  } catch {
    throw new Error("TV_EMAIL_EDGE_URL must be an HTTPS edge function URL.");
  }
  assert(
    url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    500,
    "TV_EMAIL_EDGE_URL must be an HTTPS edge function URL.",
  );
  assert(
    (env.TV_EMAIL_EDGE_SECRET || "").length >= 32 &&
      env.TV_EMAIL_EDGE_SECRET.length <= 256,
    500,
    "TV_EMAIL_EDGE_SECRET must contain 32 to 256 random characters.",
  );
  return {
    enabled: true,
    years,
    edgeUrl: url.href,
    edgeSecret: env.TV_EMAIL_EDGE_SECRET,
    anonKey: env.TV_SUPABASE_ANON_KEY,
  };
}
export const privateHash = (config, value) =>
  createHmac("sha256", Buffer.from(config.masterKey, "hex"))
    .update(`email:${value}`)
    .digest("hex");
const emailSchema = z
  .string()
  .trim()
  .max(254)
  .email()
  .refine((v) => /^[\x21-\x7e]+$/.test(v));
const capability = z.string().min(20).max(200);
const call = (store, action, id, data = {}) =>
  store.rpc("tv_email_action", { p_action: action, p_id: id, p_data: data });
const safeStatus = (row) => ({
  id: row.id,
  status:
    new Date(row.expires_at).getTime() <= Date.now() ||
    (row.status === "sent" &&
      new Date(row.code_expires_at).getTime() <= Date.now())
      ? "expired"
      : row.status,
});
function accepted(result) {
  assert(
    result && !result.error,
    result?.error === "limited" ? 429 : 409,
    result?.error === "limited"
      ? "Email checks are temporarily at capacity. Choose another method."
      : "This email check is unavailable. Start a new session or choose another method.",
  );
  return result;
}

export function emailRoutes(
  app,
  { store, config, activeSession, requireDesktop },
) {
  async function authorize(req) {
    assert(config.email?.enabled, 404, "Email experiment is not enabled.");
    const session = await activeSession(
      req.params.id,
      capability.parse(
        req.method === "GET" ? req.query.capability : req.body?.capability,
      ),
    );
    requireDesktop(req, session);
    assert(
      session.environment === "test",
      403,
      "Email history checks are currently a development experiment.",
    );
    const site = await store.one("tv_sites", { id: session.site_id });
    assert(site?.enabled, 403, "Site is disabled.");
    return session;
  }
  async function check(req) {
    const session = await authorize(req);
    const row = await store.one("tv_email_checks", {
      id: uuid.parse(req.params.checkId),
      session_id: session.id,
    });
    assert(row, 404, "Email check not found.");
    return row;
  }
  const base = "/api/verification/:id/email";
  app.post(
    base,
    route(async (req, res) => {
      const session = await authorize(req);
      const body = z
        .object({ capability, email: emailSchema, consent: z.literal(true) })
        .strict()
        .parse(req.body);
      // Preserve the delivery local-part; case-fold only the abuse-limit identifier.
      const email = body.email.replace(
        /@([^@]+)$/,
        (_, domain) => `@${domain.toLowerCase()}`,
      );
      const result = await call(store, "create", randomUUID(), {
        session_id: session.id,
        email_cipher: seal(email, config.masterKey),
        email_hash: privateHash(config, email.toLowerCase()),
        ip_hash: privateHash(config, `ip:${req.ip}`),
        minimum_years: config.email.years,
      });
      res.status(202).json(accepted(result));
    }),
  );
  app.get(
    `${base}/:checkId`,
    route(async (req, res) => res.json(safeStatus(await check(req)))),
  );
  app.post(
    `${base}/:checkId/send`,
    route(async (req, res) => {
      z.object({ capability }).strict().parse(req.body);
      const row = await check(req);
      if (
        ["send_requested", "sending", "sent", "verified"].includes(row.status)
      )
        return res.json(safeStatus(row));
      assert(
        row.status === "eligible" && row.email_cipher,
        409,
        "This address is not eligible for a code.",
      );
      const code = String(randomInt(0, 1000000)).padStart(6, "0"),
        email = unseal(row.email_cipher, config.masterKey);
      res.json(
        accepted(
          await call(store, "send", row.id, {
            code_cipher: seal(code, config.masterKey),
            code_hash: privateHash(config, `${row.id}:${code}`),
            payload_hash: hash(`${row.id}\n${email}\n${code}`),
          }),
        ),
      );
    }),
  );
  app.post(
    `${base}/:checkId/verify`,
    route(async (req, res) => {
      const body = z
        .object({ capability, code: z.string().regex(/^\d{6}$/) })
        .strict()
        .parse(req.body);
      const row = await check(req);
      res.json(
        accepted(
          await call(store, "verify", row.id, {
            code_hash: privateHash(config, `${row.id}:${body.code}`),
          }),
        ),
      );
    }),
  );
}

// Edge dispatch has a second database gate: payload binding, shared send quota,
// and a one-use claim before contacting SES. No retries on an uncertain send.
export async function sendEmailAtEdge(job, config, fetchImpl = fetch) {
  const response = await fetchImpl(config.email.edgeUrl, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(25000),
    headers: {
      "Content-Type": "application/json",
      "x-tv-email-key": config.email.edgeSecret,
      ...(config.email.anonKey
        ? { Authorization: `Bearer ${config.email.anonKey}` }
        : {}),
    },
    body: JSON.stringify({
      requestId: job.id,
      to: unseal(job.email_cipher, config.masterKey),
      code: unseal(job.code_cipher, config.masterKey),
    }),
  });
  // Provider errors may contain PII. Never surface, persist or log their bodies.
  await response.body?.cancel();
  if (!response.ok) throw new Error("email_edge_unavailable");
}
export async function runEmailJobs(store, config, dependencies = {}) {
  if (!config.email?.enabled) return;
  const {
    catalog = fetchBreachCatalog,
    lookup = checkEmailHistory,
    send = sendEmailAtEdge,
  } = dependencies;
  await call(store, "cleanup", null);
  const sending = await call(store, "claim_send", null);
  if (sending) {
    try {
      await send(sending, config);
    } catch {
      await call(store, "send_failed", sending.id);
    }
  }
  if (!(await store.one("tv_email_checks", { status: "queued" }))) return;
  const cached = await call(store, "catalog_claim", null);
  let data = cached.data;
  if (cached.fetch) {
    try {
      data = await catalog();
      await call(store, "catalog_save", null, { catalog: data });
    } catch {
      await call(store, "catalog_failed", null);
      return;
    }
  }
  if (!data) return;
  const job = await call(store, "claim", null);
  if (!job) return;
  let status = "unavailable";
  try {
    status = (await lookup(
      unseal(job.email_cipher, config.masterKey),
      data,
      job.minimum_years,
    ))
      ? "eligible"
      : "not_eligible";
  } catch (error) {
    if (error?.code === "rate_limited") await call(store, "pause", null);
  }
  await call(store, "lookup_done", job.id, { status });
}
