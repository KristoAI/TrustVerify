# Core candidate provenance record

September 19, 2026. This record distinguishes implementation origin from the final right to license a release. It does not declare a formal clean-room process: the historical application was previously inspected for audit and behavioral requirements.

| Area | Origin and treatment | Evidence / limits |
|---|---|---|
| `web/verification/`, `web/check.html` | Independently authored native browser application for the specified TrustBunny behavior. No Go.Cam classes, helpers, table conversion, templates or styles were imported into these modules. | Behavioral tests and esbuild input manifest; real-document/device parity remains outstanding. |
| MRZ parsing | Independently implemented against ICAO Doc 9303 TD1/TD2/TD3 specifications, with checksum and ambiguity tests. | Official references and acceptance limits in `DOCUMENT_COVERAGE.md`. Check digits do not establish document authenticity. |
| `server/continuation.mjs`, continuation SQL migration | Independently authored pairing/approval, device authority, atomic transition and recovery implementation using the existing service contract. | Local PostgreSQL race and HTTP boundary tests. |
| `server/`, `web/app.js`, `web/pages.mjs`, `web/styles.css`, `public/gate.js`, existing Supabase code | Retained TrustBunny service areas from the existing working tree, with bridge/recovery changes in this migration. They are not the inherited Go.Cam engine. | Prior audit identified these as newly added retention candidates, not a complete authorship or combined-work clearance. Final ownership/provenance review remains required. |
| TrustBunny logo/favicon and system-font stylesheet | Retained project branding; legacy Go.Cam illustrations/icons/fonts are excluded. | No independent rights grant for branding was established by this implementation. Confirm the owner's artwork provenance at release review. |
| Recognition/OCR scripts, model weights and OCR language data | Obtained directly from upstream and checked against recorded hashes; version/model bytes preserved according to owner direction. | `vendor/verification/manifest.json`, included upstream notices, prior model-rights audit. Full embedded/native dependency rights are not certified. |
| QR encoder | npm `qrcode` 1.5.4 (MIT), independently integrated. | Exact lockfile; independent `jsqr` decoding tests. No inherited GPL encoder/wrapper is built or served. |
| New build, asset-fetch, notice, audit and package scripts | Independently authored explicit build and package paths. | Browser input manifest, package SHA-256 manifest and actual-image inspection. Metadata/reference scanning supports the audit but is not proof of authorship. |
| npm runtime/development packages | Locked package versions with normalized declared licenses and installed notices. | `dist/dependency-inventory.json`; remaining missing `lazy` notice explicitly flagged. |
| Supabase Edge SDK | Direct import pinned to MIT `@supabase/supabase-js` 2.116.0. | `license-audit/edge-dependency.json` and exact-version MIT notice. Deno transitive graph and deployed version remain separate from root npm audit. |
| Historical `source/`, `app/`, legacy examples/build code; WordPress | Preserved in checkout, excluded from core runtime/package. | Historical licensing and attribution unchanged. WordPress remains a separate plugin. |

`dist/core-candidate/MANIFEST.json` records the exact candidate file hashes. Root `LICENSE` and package author/license metadata remain historical pending acceptance and final licensing decisions. Removing historical attribution or changing metadata alone would not establish an independently licensable core.
