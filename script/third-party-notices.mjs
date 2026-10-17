import fs from "node:fs/promises";
import path from "node:path";
const lock = JSON.parse(await fs.readFile("package-lock.json", "utf8"));
const sections = ["TrustBunny third-party notices\n\nGenerated from installed locked packages and audited vendor assets.\nApplication licensing and release-readiness are recorded separately in docs/REWORK_STATUS.md.\n"];
const inventory = [];
for (const [location, info] of Object.entries(lock.packages)) {
  if (!location) continue;
  let installed;
  try { installed = JSON.parse(await fs.readFile(`${location}/package.json`, "utf8")); }
  catch { if (info.optional) continue; throw new Error(`Missing package: ${location}`); }
  const license = typeof installed.license === "object" ? installed.license.type : installed.license || info.license;
  const files = (await fs.readdir(location)).filter((name) => /^(licen[sc]e|copying|notice)([.-]|$)/i.test(name));
  const supplemental = installed.name.startsWith("@esbuild/") ? "node_modules/esbuild/LICENSE.md"
    : installed.name.startsWith("@cbor-extract/") ? "node_modules/cbor-extract/LICENSE"
    : installed.name === "undici-types" ? "vendor/verification/licenses/undici-types-MIT.txt" : null;
  const record = { name: installed.name, version: installed.version, license, dev: !!info.dev, path: location, notices: files, supplemental };
  inventory.push(record);
  sections.push(`\n===== ${installed.name}@${installed.version} (${license}) =====\n`);
  if (supplemental) sections.push(`License from the same upstream project: ${supplemental}\n`, await fs.readFile(supplemental, "utf8"));
  for (const file of files) {
    const full = path.join(location, file);
    if ((await fs.stat(full)).isFile()) sections.push(await fs.readFile(full, "utf8"));
  }
  if (!files.length && !supplemental) {
    let embedded = null;
    for (const name of (await fs.readdir(location)).filter(name => /^readme/i.test(name))) {
      const readme = await fs.readFile(path.join(location, name), "utf8");
      const match = readme.match(/^#{1,3}\s+License\s*\r?\n([\s\S]*)/im);
      if (match && /Permission is hereby granted/.test(match[1])) { embedded = match[1].split(/\n#{1,3} /)[0]; break; }
    }
    if (embedded) { record.embeddedLicense = "README license section"; sections.push(embedded); }
    else { record.noticeReviewNeeded = true; sections.push("No separate installed notice file found; package metadata is recorded. Review embedded/source notices before release.\n"); }
  }
}
for (const file of await fs.readdir("vendor/verification/licenses")) {
  sections.push(`\n===== Vendor: ${file} =====\n`, await fs.readFile(`vendor/verification/licenses/${file}`, "utf8"));
}
await fs.mkdir("dist/assets/licenses", { recursive: true });
await fs.writeFile("dist/THIRD_PARTY_NOTICES.txt", sections.join("\n"));
await fs.copyFile("dist/THIRD_PARTY_NOTICES.txt", "dist/assets/licenses/THIRD_PARTY_NOTICES.txt");
await fs.writeFile("dist/dependency-inventory.json", JSON.stringify(inventory, null, 2) + "\n");
