import { loadConfig } from "../server/config.mjs";
import { SupabaseStore } from "../server/store.mjs";
const config = await loadConfig();
const store = new SupabaseStore(config.store);
const metrics = await store.rpc("tv_email_action", { p_action: "metrics" });
console.log(
  JSON.stringify(
    {
      window: "rolling 24 hours",
      limits: {
        "xon-email": { hour: 25, day: 100 },
        "xon-catalog": { hour: 50, day: 100 },
        "ses-send": { hour: 25, day: 100 },
      },
      ...metrics,
    },
    null,
    2,
  ),
);
