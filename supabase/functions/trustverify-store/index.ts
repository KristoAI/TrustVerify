// Privileged bridge for the private Node service. This is NOT a browser API.
// Supabase's JWT gate remains enabled; the anon JWT alone grants no access here.
import { createClient } from "npm:@supabase/supabase-js@2.116.0";
const SERVER_KEY_HASH = "__SERVER_KEY_HASH__";
const tables = new Set([
  "tv_accounts",
  "tv_sites",
  "tv_api_keys",
  "tv_visitors",
  "tv_passkeys",
  "tv_proofs",
  "tv_sessions",
  "tv_tokens",
  "tv_webhooks",
  "tv_audit",
  "tv_continuations",
  "tv_email_checks",
]);
const procedures = new Set([
  "tv_consume_token",
  "tv_finish_session",
  "tv_claim_webhooks",
  "tv_cleanup",
  "tv_revoke_session",
  "tv_forget_proofs",
  "tv_continuation",
  "tv_bind_desktop",
  "tv_email_action",
]);
const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const credential = req.headers.get("x-tv-server-key") || "";
  if (credential.length !== 64) return json({ error: "Unauthorized" }, 401);
  const digest = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(credential),
      ),
    ),
  )
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  let diff = 0;
  for (let i = 0; i < 64; i++)
    diff |= digest.charCodeAt(i) ^ SERVER_KEY_HASH.charCodeAt(i);
  if (diff !== 0) return json({ error: "Unauthorized" }, 401);
  try {
    const raw = await req.text();
    if (raw.length > 2000000) return json({ error: "Too large" }, 413);
    const p = JSON.parse(raw);
    if (raw.length > 150000 && !(p.op === "rpc" && p.name === "tv_email_action" && p.args?.p_action === "catalog_save"))
      return json({ error: "Too large" }, 413);
    let query;
    if (p.op === "rpc") {
      if (!procedures.has(p.name))
        return json({ error: "Procedure denied" }, 403);
      query = db.rpc(p.name, p.args || {});
    } else {
      if (!tables.has(p.table)) return json({ error: "Table denied" }, 403);
      if (["update", "delete"].includes(p.op) && !p.filters?.length)
        return json({ error: "Filter required" }, 400);
      const t = db.from(p.table);
      if (p.op === "select") query = t.select("*");
      else if (p.op === "insert") query = t.insert(p.data).select();
      else if (p.op === "update") query = t.update(p.data).select();
      else if (p.op === "delete") query = t.delete().select();
      else return json({ error: "Operation denied" }, 400);
      for (const [column, op, value] of p.filters || []) {
        if (
          !/^[a-z_]+$/.test(column) ||
          !["eq", "is", "in", "lt", "lte", "gt", "gte"].includes(op)
        )
          return json({ error: "Invalid filter" }, 400);
        query = query[op](column, value);
      }
      if (p.op === "select") {
        if (p.order && /^[a-z_]+$/.test(p.order))
          query = query.order(p.order, { ascending: !!p.ascending });
        query = query.limit(Math.min(Math.max(p.limit || 100, 1), 200));
      }
    }
    const { data, error } = await query;
    if (error) return json({ error: error.message, code: error.code }, 400);
    return json({ data });
  } catch {
    return json({ error: "Invalid request" }, 400);
  }
});
