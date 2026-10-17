import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

export async function auditCore() {
  const problems = [];
  const lock = JSON.parse(await fs.readFile("package-lock.json", "utf8"));
  const installed = new Map(JSON.parse(await fs.readFile("dist/dependency-inventory.json", "utf8")).map(p => [p.path, p]));
  const allowed = new Set(["MIT", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "0BSD"]);
  for (const [name, info] of Object.entries(lock.packages)) {
    if (!name) continue; // The historical root license is a separate release decision.
    const current = installed.get(name);
    if (current && current.version !== info.version) problems.push(`Installed version differs from lock: ${name}`);
    const license = current?.license || (typeof info.license === "object" ? info.license.type : info.license);
    if (!allowed.has(license)) problems.push(`Unreviewed dependency license: ${name}: ${license}`);
  }
  const inputs = JSON.parse(await fs.readFile("dist/browser-inputs.json", "utf8"));
  for (const input of inputs) if (!/^(web\/|node_modules\/)/.test(input))
    problems.push(`Unexpected browser build input: ${input}`);
  const manifest = JSON.parse(await fs.readFile("vendor/verification/manifest.json", "utf8"));
  for (const entry of manifest.artifacts) {
    const bytes = await fs.readFile(`dist/assets/${entry.path}`);
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
      problems.push(`Changed vendor artifact: ${entry.path}`);
    if (!allowed.has(entry.license)) problems.push(`Unreviewed vendor license: ${entry.path}`);
  }
  const files = [];
  async function walk(folder) {
    for (const item of await fs.readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, item.name);
      if (item.isDirectory()) await walk(file);
      else files.push(file);
    }
  }
  for (const folder of ["server", "web", "dist/assets"]) await walk(folder);
  for (const file of files) {
    if (!/\.(?:m?js|ts|html|css|svg)$/.test(file)) continue;
    const content = await fs.readFile(file, "utf8");
    if (/\b(?:AvsFactory|AvsToken)\b|\bAvs\.(?:Helper|Plugin|Config|Entity)|\/static\/|qr-code\/v1ncc/.test(content))
      problems.push(`Legacy reference in active source/output: ${file}`);
  }
  const report = {
    checkedAt: new Date().toISOString(), dependencyInstances: Object.keys(lock.packages).length - 1,
    vendorArtifacts: manifest.artifacts.length, browserInputs: inputs.length,
    problems,
    limits: [
      "This checks declared dependencies, known references and audited vendor hashes; it is not a legal provenance opinion.",
      "Legacy source remains in the working repository as migration evidence and is excluded from the candidate package.",
      "Root LICENSE and package metadata remain AGPL pending coverage acceptance and final licensing review.",
      "OS/container licenses, model rights and GeoLite terms remain separately documented.",
    ],
  };
  await fs.writeFile("dist/core-audit.json", JSON.stringify(report, null, 2) + "\n");
  if (problems.length) throw new Error(problems.join("\n"));
  return report;
}
const result = await auditCore();
console.log(`Core audit passed: ${result.dependencyInstances} dependency declarations, ${result.vendorArtifacts} vendor hashes, ${result.browserInputs} browser inputs. Root licensing decision remains outstanding.`);
