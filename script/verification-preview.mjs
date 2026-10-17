// Isolated local preview. Never reads deployment configuration or credentials.
// Requires a disposable Postgres container with the repository migrations applied.
import express from "express";
import fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { build } from "esbuild";
import { createPreviewStore } from "./preview-store.mjs";
import { createApp } from "../server/app.mjs";
import { makeSigningKeys } from "../server/security.mjs";
const store = createPreviewStore(process.env.TV_PREVIEW_CONTAINER);
const origin = "http://127.0.0.1:3318";
// Persist only preview keys, separately from the hosted application's keys.
// Rebuilding/restarting the dev server must not invalidate test-session recovery.
await fs.mkdir('.local', { recursive: true });
const previewKeyFile = `.local/${process.env.TV_PREVIEW_CONTAINER}-preview-keys.json`;
let previewKeys;
try { previewKeys = JSON.parse(await fs.readFile(previewKeyFile, 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  previewKeys = { keys: await makeSigningKeys(), masterKey: randomBytes(32).toString('hex') };
  await fs.writeFile(previewKeyFile, JSON.stringify(previewKeys), { mode: 0o600, flag: 'wx' });
}
const config = { origin, secure: false, ...previewKeys, rpID: "127.0.0.1", trustProxy: false };
await build({ entryPoints: ["tests/browser/verification-fixtures.ts"], outfile: "dist/browser-fixtures.js", bundle: true, format: "iife", platform: "browser", target: "es2022" });
const app = express();
app.get("/preview/fixtures", async (req,res) => {
  res.set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:");
  res.type("html").send(await fs.readFile("tests/browser/verification-fixtures.html", "utf8"));
});
app.get("/preview/fixtures.js", (req,res) => res.sendFile("browser-fixtures.js", {root:"dist"}));
app.use(await createApp({ store, config, geo: () => null }));
app.listen(3318, "127.0.0.1", () => console.log(`Isolated verification preview: ${origin}`));
