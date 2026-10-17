// Server-to-server edge sender. Keep the Supabase JWT gateway enabled as an
// additional layer; its JWT alone never authorizes a send.
import { createEmailHandler } from "./email.mjs";

const config = {
  secret: Deno.env.get("TV_EMAIL_EDGE_SECRET"),
  from: Deno.env.get("TV_EMAIL_FROM"),
  region: Deno.env.get("AWS_REGION"),
  accessKeyId: Deno.env.get("AWS_ACCESS_KEY_ID"),
  secretAccessKey: Deno.env.get("AWS_SECRET_ACCESS_KEY"),
  sessionToken: Deno.env.get("AWS_SESSION_TOKEN"),
  configurationSet: Deno.env.get("TV_EMAIL_SES_CONFIGURATION_SET"),
};

async function action(
  action: string,
  id: string,
  data: Record<string, unknown> = {},
) {
  const endpoint = Deno.env.get("SUPABASE_URL");
  const credential = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!endpoint || !credential) throw new Error("Email store unavailable");
  const response = await fetch(
    `${endpoint.replace(/\/$/, "")}/rest/v1/rpc/tv_email_action`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: credential,
        Authorization: `Bearer ${credential}`,
      },
      body: JSON.stringify({ p_action: action, p_id: id, p_data: data }),
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Email store unavailable");
  }
  const result = await response.json();
  return result;
}

Deno.serve(
  createEmailHandler({
    config,
    claim: (id: string, payloadHash: string) =>
      action("dispatch", id, { payloadHash }),
    finish: async (id: string, accepted: boolean) => {
      const result = await action(accepted ? "sent" : "send_failed", id);
      if (
        result?.error ||
        result?.status !== (accepted ? "sent" : "unavailable")
      ) {
        throw new Error("Email state update failed");
      }
    },
  }),
);
