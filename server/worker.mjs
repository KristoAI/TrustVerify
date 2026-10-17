import { runEmailJobs } from "./email.mjs";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.mjs";
import { SupabaseStore } from "./store.mjs";
import {
  after,
  now,
  unseal,
  webhookSignature,
  deliverWebhook,
} from "./security.mjs";
export async function runDeliveries(store, config, deliver = deliverWebhook) {
  const jobs = await store.rpc("tv_claim_webhooks", { p_limit: 10 });
  for (const job of jobs) {
    let status = 0,
      error = "delivery_failed";
    try {
      const site = await store.one("tv_sites", { id: job.site_id });
      if (!site?.enabled || !site.webhook_url || !site.webhook_secret)
        throw new Error("endpoint_disabled");
      const body = JSON.stringify({
        id: job.id,
        type: job.event_type,
        created_at: job.created_at,
        data: job.payload,
      });
      status = await deliver(
        site.webhook_url,
        body,
        webhookSignature(body, unseal(site.webhook_secret, config.masterKey)),
      );
      error = status >= 200 && status < 300 ? null : `http_${status}`;
    } catch (e) {
      error =
        e.message === "endpoint_disabled"
          ? "endpoint_disabled"
          : "network_or_destination_error";
    }
    const delivered = !error,
      exhausted =
        Date.now() - new Date(job.created_at).getTime() > 86400000 ||
        job.attempts >= 12;
    // Lease identity prevents a slow worker from overwriting a newer delivery attempt.
    await store.update(
      "tv_webhooks",
      { id: job.id, attempts: job.attempts, lease_until: job.lease_until },
      {
        status: delivered ? "delivered" : exhausted ? "failed" : "pending",
        http_status: status || null,
        error_code: error,
        delivered_at: delivered ? now() : null,
        lease_until: null,
        next_attempt_at: after(
          Math.min(3600, 15 * 2 ** job.attempts) +
            Math.floor(Math.random() * 10),
        ),
      },
    );
  }
  return jobs.length;
}
export function startWorker(store, config) {
  let running = false,
    lastCleanup = 0;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runDeliveries(store, config);
      await runEmailJobs(store, config);
      if (Date.now() - lastCleanup > 3600000) {
        await store.rpc("tv_cleanup");
        lastCleanup = Date.now();
      }
    } catch {
      console.error("TrustBunny background delivery temporarily unavailable.");
    } finally {
      running = false;
    }
  };
  const interval = setInterval(tick, 15000);
  interval.unref();
  void tick();
  return () => clearInterval(interval);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const config = await loadConfig(),
    store = new SupabaseStore(config.store);
  startWorker(store, config);
  setInterval(() => {}, 3600000);
  console.log("TrustBunny delivery worker started.");
}
