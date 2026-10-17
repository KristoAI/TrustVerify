# Direct npm dependencies

Audited September 19, 2026 against the local lockfile and installed manifests. These are package license declarations, not clearance of the application, bundled assets, model/data rights, or every embedded dependency. See [the full audit](../LICENSE_AUDIT.md).

| Package | Exact version | Declared license | Manifest category | Top-level installed license files |
|---|---|---|---|---|
| `@simplewebauthn/browser` | 14.0.0 | MIT | runtime | `LICENSE.md` |
| `@simplewebauthn/server` | 14.0.2 | MIT | runtime | `LICENSE.md` |
| `@types/cookie-parser` | 1.4.9 | MIT | development | `LICENSE` |
| `@types/dotenv` | 6.1.1 | MIT | development | `LICENSE` |
| `@types/express` | 4.17.21 | MIT | development | `LICENSE` |
| `@types/express-session` | 1.18.0 | MIT | development | `LICENSE` |
| `@types/jquery` | 3.5.29 | MIT | development | `LICENSE` |
| `@types/morgan` | 1.9.10 | MIT | development | `LICENSE` |
| `@types/node` | 20.12.7 | MIT | development | `LICENSE` |
| `@types/serve-favicon` | 2.5.7 | MIT | development | `LICENSE` |
| `@types/ua-parser-js` | 0.7.39 | MIT | development | `LICENSE` |
| `axios` | 1.20.0 | MIT | runtime | `LICENSE` |
| `body-parser` | 1.20.8 | MIT | runtime | `LICENSE` |
| `cbor-x` | 1.6.6 | MIT | runtime | `LICENSE` |
| `compass-importer` | 0.4.1 | ISC | development | None found; inspect README/upstream |
| `cookie-parser` | 1.4.7 | MIT | runtime | `LICENSE` |
| `dotenv` | 17.2.0 | BSD-2-Clause | runtime | `LICENSE` |
| `esbuild` | 0.28.2 | MIT | runtime | `LICENSE.md` |
| `express` | 4.22.3 | MIT | runtime | `LICENSE` |
| `express-rate-limit` | 8.7.0 | MIT | runtime | `license` |
| `express-session` | 1.19.0 | MIT | runtime | `LICENSE` |
| `geoip-lite` | 2.0.3 | Apache-2.0 | runtime | `LICENSE` |
| `gulp` | 5.0.0 | MIT | development | `LICENSE` |
| `gulp-clean` | 0.4.0 | MIT | development | None found; inspect README/upstream |
| `gulp-cli` | 3.0.0 | MIT | development | `LICENSE` |
| `gulp-concat` | 2.6.1 | MIT | runtime | `LICENSE` |
| `gulp-sass` | 5.1.0 | MIT | development | `LICENSE` |
| `gulp-typescript` | 6.0.0-alpha.1 | MIT | development | None found; inspect README/upstream |
| `helmet` | 8.3.0 | MIT | runtime | `LICENSE` |
| `ipaddr.js` | 2.5.0 | MIT | runtime | `LICENSE` |
| `jose` | 6.2.12 | MIT | runtime | `LICENSE.md` |
| `morgan` | 1.12.1 | MIT | runtime | `LICENSE` |
| `prettier` | 3.9.8 | MIT | development | `LICENSE` |
| `sass` | 1.76.0 | MIT | development | `LICENSE` |
| `serve-favicon` | 2.5.0 | MIT | runtime | `LICENSE` |
| `typescript` | 5.8.3 | Apache-2.0 | development | `LICENSE.txt` |
| `ua-parser-js` | 1.0.37 | MIT | runtime | `license.md` |
| `zod` | 4.6.5 | MIT | runtime | `LICENSE` |

All 38 direct dependencies were installed at their locked versions. The complete 474-instance inventory, including nested/optional dependencies, is in [inventory.json](inventory.json).

`@supabase/supabase-js@2` is imported separately by the Edge function and is not included in this root lockfile. Its upstream license is MIT; the exact deployed version remains unverified.

The application itself is declared AGPL-3.0. The standalone QR bundle is GPLv3 and therefore does not appear in the permissive-only npm summary.
