import { z } from "zod";
import {
  assert,
  route,
  createToken,
  readToken,
  cookieOptions,
  policySchema,
  brandingSchema,
  uuid,
} from "./domain.mjs";
import {
  hash,
  random,
  passwordHash,
  passwordMatches,
  after,
  seal,
  allowedReturn,
  webhookTarget,
  now,
} from "./security.mjs";
export function accountRoutes(app, { store, config }) {
  const authBody = z
    .object({
      email: z
        .string()
        .email()
        .max(254)
        .transform((s) => s.toLowerCase().trim()),
      password: z.string().min(12).max(128),
    })
    .strict();
  const safeAccount = (a) => ({
    id: a.id,
    name: a.name,
    email: a.email,
    created_at: a.created_at,
  });
  const safeSite = (s) => {
    const { webhook_secret, ...safe } = s;
    return { ...safe, has_webhook_secret: !!webhook_secret };
  };
  const issue = async (res, account) => {
    const token = await createToken(store, "admin", account.id, {}, 7 * 86400);
    res.cookie("tv_admin", token, cookieOptions(config, 7 * 86400));
  };
  app.post(
    "/api/account/register",
    route(async (req, res) => {
      const data = authBody
          .extend({ name: z.string().trim().min(2).max(80) })
          .parse(req.body),
        recovery = random(24);
      assert(
        !(await store.one("tv_accounts", { email: data.email })),
        409,
        "An account already uses this email. Sign in or use your recovery code.",
      );
      const account = await store.insert("tv_accounts", {
        name: data.name,
        email: data.email,
        password_hash: await passwordHash(data.password),
        recovery_hash: hash(recovery),
      });
      await issue(res, account);
      res
        .status(201)
        .json({ account: safeAccount(account), recovery_code: recovery });
    }),
  );
  app.post(
    "/api/account/login",
    route(async (req, res) => {
      const data = authBody.parse(req.body),
        account = await store.one("tv_accounts", { email: data.email });
      const valid = await passwordMatches(
        data.password,
        account?.password_hash || `${"0".repeat(22)}:${"0".repeat(128)}`,
      );
      assert(account && valid, 401, "Email or password is incorrect.");
      await issue(res, account);
      res.json({ account: safeAccount(account) });
    }),
  );
  app.post(
    "/api/account/recover",
    route(async (req, res) => {
      const data = authBody
          .extend({ recovery_code: z.string().min(20).max(100) })
          .parse(req.body),
        account = await store.one("tv_accounts", {
          email: data.email,
          recovery_hash: hash(data.recovery_code),
        });
      assert(account, 401, "The recovery details did not match.");
      const code = random(24);
      const rows = await store.update(
        "tv_accounts",
        { id: account.id, recovery_hash: hash(data.recovery_code) },
        {
          password_hash: await passwordHash(data.password),
          recovery_hash: hash(code),
        },
      );
      assert(rows.length, 409, "Recovery code already used.");
      await store.remove("tv_tokens", { kind: "admin", owner_id: account.id });
      await issue(res, account);
      res.json({ recovery_code: code });
    }),
  );
  app.post(
    "/api/account/logout",
    route(async (req, res) => {
      if (req.cookies.tv_admin)
        await store.remove("tv_tokens", {
          hash: hash(req.cookies.tv_admin),
          kind: "admin",
        });
      res.clearCookie("tv_admin", cookieOptions(config, 0));
      res.json({ ok: true });
    }),
  );
  const requireAdmin = route(async (req, res, next) => {
    const auth = await readToken(store, req.cookies.tv_admin, "admin");
    assert(auth, 401, "Sign in to your client account.");
    req.account = await store.one("tv_accounts", { id: auth.owner_id });
    assert(req.account, 401, "Account unavailable.");
    next();
  });
  app.use("/api/dashboard", requireAdmin);
  app.get(
    "/api/dashboard",
    route(async (req, res) => {
      const sites = await store.find(
        "tv_sites",
        { account_id: req.account.id },
        { order: "created_at" },
      );
      const sessions = (
        await Promise.all(
          sites.map((s) =>
            store.find(
              "tv_sessions",
              { site_id: s.id },
              { order: "created_at", limit: 50 },
            ),
          ),
        )
      )
        .flat()
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, 100);
      const webhooks = (
        await Promise.all(
          sites.map((s) =>
            store.find(
              "tv_webhooks",
              { site_id: s.id },
              { order: "created_at", limit: 30 },
            ),
          ),
        )
      )
        .flat()
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, 60);
      const keys = (
        await Promise.all(
          sites.map((s) =>
            store.find(
              "tv_api_keys",
              { site_id: s.id },
              { order: "created_at" },
            ),
          ),
        )
      )
        .flat()
        .map(({ key_hash, ...key }) => key);
      res.json({
        account: safeAccount(req.account),
        sites: sites.map(safeSite),
        sessions: sessions.map(
          ({
            cap_hash,
            launch_cipher,
            state_nonce,
            ip_hash,
            proof_id,
            request_hash,
            ...s
          }) => s,
        ),
        webhooks: webhooks.map(({ payload, ...w }) => w),
        keys,
        origin: config.origin,
      });
    }),
  );
  const siteSchema = z
    .object({
      name: z.string().trim().min(2).max(80),
      origin: z.string().url().max(250),
      return_url: z.string().url().max(500),
      environment: z.enum(["test", "live"]),
      policy: policySchema,
      branding: brandingSchema,
      webhook_url: z.string().url().max(500).nullable().default(null),
      enabled: z.boolean().default(true),
    })
    .strict();
  const validate = async (data) => {
    try {
      const url = new URL(data.origin);
      assert(
        url.origin === data.origin && !url.username && !url.password,
        400,
        "Enter an origin only, such as https://example.com",
      );
      data.return_url = allowedReturn(
        data.return_url,
        data.origin,
        data.environment,
      );
      if (data.webhook_url) await webhookTarget(data.webhook_url);
      if (data.policy.mode === "regions")
        assert(
          data.policy.regions.length > 0,
          400,
          "Add at least one country or region.",
        );
      return data;
    } catch (e) {
      assert(false, 400, e.message);
    }
  };
  app.post(
    "/api/dashboard/sites",
    route(async (req, res) => {
      const data = await validate(siteSchema.parse(req.body));
      assert(
        (await store.find("tv_sites", { account_id: req.account.id })).length <
          20,
        400,
        "This account supports up to 20 sites.",
      );
      const webhookSecret = data.webhook_url ? random() : null;
      const site = await store.insert("tv_sites", {
        ...data,
        account_id: req.account.id,
        webhook_secret: webhookSecret
          ? seal(webhookSecret, config.masterKey)
          : null,
      });
      const key = `tv_${site.environment}_${random()}`;
      await store.insert("tv_api_keys", {
        site_id: site.id,
        name: "Initial key",
        prefix: key.slice(0, 16),
        key_hash: hash(key),
      });
      await store.insert("tv_audit", {
        account_id: req.account.id,
        action: "site.created",
        resource_id: site.id,
      });
      res.status(201).json({
        site: safeSite(site),
        api_key: key,
        webhook_secret: webhookSecret,
      });
    }),
  );
  async function ownedSite(req, id) {
    uuid.parse(id);
    const s = await store.one("tv_sites", { id, account_id: req.account.id });
    assert(s, 404, "Site not found.");
    return s;
  }
  app.put(
    "/api/dashboard/sites/:id",
    route(async (req, res) => {
      const site = await ownedSite(req, req.params.id),
        data = await validate(siteSchema.parse(req.body));
      assert(
        site.environment === data.environment,
        400,
        "Create a new site to change environments.",
      );
      data.policy.version = site.policy.version + 1;
      let secret;
      if (data.webhook_url !== site.webhook_url) {
        secret = data.webhook_url ? random() : null;
        data.webhook_secret = secret ? seal(secret, config.masterKey) : null;
      }
      await store.update("tv_sites", { id: site.id }, data);
      await store.insert("tv_audit", {
        account_id: req.account.id,
        action: "site.updated",
        resource_id: site.id,
      });
      res.json({
        site: safeSite({ ...site, ...data }),
        webhook_secret: secret,
      });
    }),
  );
  app.post(
    "/api/dashboard/sites/:id/keys",
    route(async (req, res) => {
      const site = await ownedSite(req, req.params.id);
      const name = z.string().trim().min(1).max(60).parse(req.body.name);
      const key = `tv_${site.environment}_${random()}`;
      await store.insert("tv_api_keys", {
        site_id: site.id,
        name,
        prefix: key.slice(0, 16),
        key_hash: hash(key),
      });
      res.status(201).json({ api_key: key });
    }),
  );
  app.delete(
    "/api/dashboard/keys/:id",
    route(async (req, res) => {
      const key = await store.one("tv_api_keys", {
        id: uuid.parse(req.params.id),
      });
      assert(key, 404, "Key not found.");
      await ownedSite(req, key.site_id);
      await store.update("tv_api_keys", { id: key.id }, { revoked_at: now() });
      res.json({ ok: true });
    }),
  );
  app.post(
    "/api/dashboard/webhooks/:id/retry",
    route(async (req, res) => {
      const event = await store.one("tv_webhooks", {
        id: uuid.parse(req.params.id),
      });
      assert(event, 404, "Delivery not found.");
      await ownedSite(req, event.site_id);
      assert(
        event.status !== "processing",
        409,
        "Delivery already in progress.",
      );
      await store.update(
        "tv_webhooks",
        { id: event.id },
        { status: "pending", next_attempt_at: after(0), attempts: 0 },
      );
      res.json({ ok: true });
    }),
  );
  app.post(
    "/api/dashboard/sessions/:id/revoke",
    route(async (req, res) => {
      const session = await store.one("tv_sessions", {
        id: uuid.parse(req.params.id),
      });
      assert(session, 404, "Session not found.");
      await ownedSite(req, session.site_id);
      await store.rpc("tv_revoke_session", {
        p_session_id: session.id,
        p_site_id: session.site_id,
      });
      res.json({ ok: true });
    }),
  );
  return { requireAdmin, ownedSite };
}
