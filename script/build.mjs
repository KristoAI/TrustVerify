import { build } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
await import("./openapi.mjs");
const output = "dist/assets";
await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(output, { recursive: true });
const inputs = new Set();
for (const [entry, name] of [["web/app.js", "app.js"], ["web/verification/index.ts", "verification.js"]]) {
  const result = await build({
    entryPoints: [entry], bundle: true, minify: true, format: "iife",
    platform: "browser", target: ["es2022"], legalComments: "linked",
    outfile: `${output}/${name}`, metafile: true,
  });
  for (const input of Object.keys(result.metafile.inputs)) inputs.add(input);
}
for (const [source, name] of [
  ["web/styles.css", "styles.css"],
  ["web/verification/styles.css", "verification.css"],
  ["public/assets/fonts.css", "fonts.css"],
  ["public/assets/logo.svg", "logo.svg"],
  ["public/assets/favicon.svg", "favicon.svg"],
]) await fs.copyFile(source, `${output}/${name}`);
const manifest = JSON.parse(await fs.readFile("vendor/verification/manifest.json", "utf8"));
for (const entry of manifest.artifacts) {
  const source = `vendor/verification/${entry.path}`;
  const bytes = await fs.readFile(source);
  if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
    throw new Error(`Vendor hash mismatch: ${source}. Run npm run assets:fetch to restore it.`);
  const destination = path.join(output, entry.path);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, bytes);
}
await fs.writeFile("dist/browser-inputs.json", JSON.stringify([...inputs].sort(), null, 2) + "\n");
await import("./third-party-notices.mjs");
console.log("Built independent TrustBunny verification and application assets.");
