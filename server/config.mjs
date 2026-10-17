import "dotenv/config";
import { emailConfig } from "./email.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { makeSigningKeys } from "./security.mjs";
export async function loadConfig() {
  const origin = process.env.TV_ORIGIN || "http://localhost:3300";
  const parsedOrigin = new URL(origin);
  if (
    parsedOrigin.origin !== origin ||
    (!origin.startsWith("https:") &&
      !["localhost", "127.0.0.1", "[::1]"].includes(parsedOrigin.hostname))
  )
    throw new Error(
      "TV_ORIGIN must be an exact HTTPS origin, or localhost for development.",
    );
  if (!/^[a-f0-9]{64}$/i.test(process.env.TV_MASTER_KEY || ""))
    throw new Error(
      "TV_MASTER_KEY must be 32 random bytes encoded as 64 hex characters.",
    );
  const dir = path.resolve(".local");
  await fs.mkdir(dir, { recursive: true });
  const keyPath = path.join(dir, "signing-keys.json");
  let keys;
  try {
    keys = JSON.parse(await fs.readFile(keyPath, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    keys = await makeSigningKeys();
    await fs.writeFile(keyPath, JSON.stringify(keys), { mode: 0o600 });
  }
  for (const name of [
    "TV_STORE_SECRET",
    "TV_MASTER_KEY",
    "TV_SUPABASE_ANON_KEY",
  ])
    if (!process.env[name])
      throw new Error(`Missing ${name}; see docs/OPERATIONS.md`);
  return {
    origin,
    email: emailConfig(),
    port: Number(process.env.HTTP_SERVER_PORT || 3300),
    host: process.env.HTTP_SERVER_HOST || "localhost",
    secure: origin.startsWith("https:"),
    masterKey: process.env.TV_MASTER_KEY,
    keys,
    store: {
      url: process.env.TV_STORE_URL,
      secret: process.env.TV_STORE_SECRET,
      anonKey: process.env.TV_SUPABASE_ANON_KEY,
    },
    rpID: new URL(origin).hostname,
    trustProxy: process.env.TV_TRUST_PROXY
      ? process.env.TV_TRUST_PROXY.split(",").map((s) => s.trim())
      : false,
  };
}
