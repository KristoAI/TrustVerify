import { z } from "zod";
import { after, hash, isFuture, random } from "./security.mjs";
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const assert = (condition, status, message) => {
  if (!condition) throw new HttpError(status, message);
};
export const route = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
export const uuid = z.string().uuid();
// Live AI checks always include document reinforcement; legacy selfie-only
// policies are interpreted without rewriting stored site or session snapshots.
export function effectiveMethods(policy) {
  return policy.methods.includes("selfie")
    ? ["selfie", "document"]
    : [...new Set(policy.methods)];
}
export const policySchema = z
  .object({
    minAge: z.number().int().min(18).max(99),
    maxAgeHours: z.number().int().min(1).max(8760),
    methods: z.array(z.enum(["selfie", "document"])).min(1),
    mode: z.enum(["everywhere", "regions"]),
    regions: z.array(z.string().regex(/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/)).max(100),
    unknown: z.enum(["require", "allow", "deny"]),
    version: z.number().int().positive().default(1),
  })
  .strict()
  .transform((policy) => ({ ...policy, methods: effectiveMethods(policy) }));
export const brandingSchema = z
  .object({
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    title: z.string().min(1).max(80),
  })
  .strict();
export const defaultPolicy = {
  minAge: 18,
  maxAgeHours: 8760,
  methods: ["selfie", "document"],
  mode: "everywhere",
  regions: [],
  unknown: "require",
  version: 1,
};
export function evaluatePolicy(policy, geo) {
  if (policy.mode === "everywhere")
    return { decision: "required", reason: "site_policy" };
  if (!geo?.country)
    return {
      decision:
        policy.unknown === "allow"
          ? "not_required"
          : policy.unknown === "deny"
            ? "denied"
            : "required",
      reason: "unknown_location",
    };
  const match =
    policy.regions.includes(geo.country) ||
    policy.regions.includes(`${geo.country}-${geo.region}`);
  return {
    decision: match ? "required" : "not_required",
    reason: match ? "region_rule" : "outside_regions",
  };
}
export function proofMeets(proof, policy, environment) {
  return (
    !!proof &&
    !proof.revoked_at &&
    proof.environment === environment &&
    isFuture(proof.expires_at) &&
    proof.min_age >= policy.minAge &&
    effectiveMethods(policy).includes(proof.method) &&
    new Date(proof.verified_at).getTime() + policy.maxAgeHours * 3600000 >
      Date.now()
  );
}
export function publicResult(session) {
  return {
    session_id: session.id,
    site_id: session.site_id,
    status:
      session.status === "completed" || isFuture(session.expires_at)
        ? session.status
        : "expired",
    outcome: session.outcome || null,
    environment: session.environment,
    age_over: session.min_age,
    method: session.method || null,
    assurance: "browser_asserted",
    source: session.source || null,
    created_at: session.created_at,
    completed_at: session.completed_at || null,
    verified_at: session.verified_at || null,
    valid_until: session.valid_until || null,
  };
}
export function cookieOptions(config, seconds) {
  return {
    httpOnly: true,
    secure: config.secure,
    sameSite: "lax",
    path: "/",
    maxAge: seconds * 1000,
  };
}
export async function createToken(
  store,
  kind,
  owner,
  data = {},
  seconds = 600,
) {
  const token = random();
  await store.insert("tv_tokens", {
    hash: hash(token),
    kind,
    owner_id: owner,
    data,
    expires_at: after(seconds),
  });
  return token;
}
export async function readToken(store, token, kind) {
  if (!token) return null;
  const row = await store.one("tv_tokens", { hash: hash(token), kind });
  return row && isFuture(row.expires_at) ? row : null;
}
export const proofCookie = (environment) =>
  environment === "test" ? "tv_proof_test" : "tv_proof";
export async function cookieProof(store, req, environment) {
  const t = req.cookies[proofCookie(environment)];
  if (!t) return null;
  const original = await store.one("tv_proofs", { token_hash: hash(t) });
  if (original) return original;
  const alias = await readToken(store, t, "proof-access");
  return alias ? store.one("tv_proofs", { id: alias.owner_id }) : null;
}
