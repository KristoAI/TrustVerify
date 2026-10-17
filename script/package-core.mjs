// An explicit candidate package: never copy the historical checkout wholesale.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
await import("./build.mjs");
await import("./audit-core.mjs");
const destination = "dist/core-candidate";
await fs.rm(destination, { recursive: true, force: true });
await fs.mkdir(destination, { recursive: true });
const sources = [
  "server", "supabase/migrations", "supabase/functions", "web/pages.mjs", "web/check.html", "public/gate.js", "public/openapi.json",
  "dist/assets", "dist/THIRD_PARTY_NOTICES.txt", "dist/dependency-inventory.json", "dist/core-audit.json",
  "package.json", "package-lock.json", "LICENSE", "docs/REWORK_STATUS.md", "docs/DEPLOYMENT_STATUS.md", "docs/EMAIL_EXPERIMENT.md", "script/email-usage.mjs", "docs/DOCUMENT_COVERAGE.md", "docs/CORE_PROVENANCE.md", "docs/OPERATIONS.md", "docs/DOCUMENT_SELECTION.md",
  "docs/license-audit/edge-dependency.json", "docs/license-audit/supabase-js-2.116.0-MIT.txt",
];
for (const source of sources) {
  const target = path.join(destination, source);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(source, target, { recursive: true });
}
const entries = [];
async function inventory(folder) {
  for (const item of await fs.readdir(folder, { withFileTypes: true })) {
    const file = path.join(folder, item.name);
    if (item.isDirectory()) await inventory(file);
    else entries.push({ path: path.relative(destination, file), sha256: createHash("sha256").update(await fs.readFile(file)).digest("hex") });
  }
}
await inventory(destination);
await fs.writeFile(`${destination}/MANIFEST.json`, JSON.stringify({ status: "migration candidate, not cleared proprietary release", files: entries }, null, 2) + "\n");
console.log(`Created ${destination}: ${entries.length} allowlisted files. Run npm ci --omit=dev inside it for runtime dependencies. See docs/REWORK_STATUS.md before deployment.`);
