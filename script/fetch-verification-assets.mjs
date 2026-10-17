// Fetch only audited upstream assets. Builds use the local, hash-verified copies.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
const root = new URL("../vendor/verification/", import.meta.url);
const manifest = JSON.parse(await fs.readFile(new URL("manifest.json", root), "utf8"));
for (const entry of manifest.artifacts) {
  const target = new URL(entry.path, root);
  let data = await fs.readFile(target).catch(() => null);
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  if (data && digest(data) === entry.sha256) continue;
  const response = await fetch(entry.url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Upstream asset failed: ${entry.path} (${response.status})`);
  data = Buffer.from(await response.arrayBuffer());
  if (digest(data) !== entry.sha256) throw new Error(`Upstream checksum changed: ${entry.path}`);
  await fs.mkdir(path.dirname(target.pathname), { recursive: true });
  await fs.writeFile(target, data);
  console.log(`Fetched ${entry.path}`);
}
