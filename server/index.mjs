import { loadConfig } from "./config.mjs";
import { SupabaseStore } from "./store.mjs";
import { createApp } from "./app.mjs";
import { startWorker } from "./worker.mjs";
const config = await loadConfig(),
  store = new SupabaseStore(config.store),
  app = await createApp({ store, config });
const server = app.listen(config.port, config.host, () =>
  console.log(`TrustBunny ready at ${config.origin}`),
);
const stopWorker = startWorker(store, config);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    if (typeof stopWorker === "function") stopWorker();
    server.close(() => process.exit(0));
  });
