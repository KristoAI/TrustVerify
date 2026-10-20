# TrustBunny component license audit

This is the pre-replacement audit snapshot. The build, dependency count, QR encoder, Edge pin and container base have since changed; see [current implementation status](REWORK_STATUS.md) and generated `dist/core-audit.json` for the candidate. Historical findings remain recorded here.

Reviewed September 19, 2026. This is a technical license and provenance assessment of the local working tree, not a legal clearance opinion. No application code, license declarations, deployment, or repository visibility was changed.

**Subsequent owner direction (September 19, 2026):** The owner reports that counsel supports retaining the recognition libraries/models for this use case and requests replacement of GPL/AGPL components in the core service, excluding the WordPress plugin. The [replacement plan](GPL_REPLACEMENT_PLAN.md) adopts that scope. The original provenance findings below remain recorded; model replacement is no longer proposed as a prerequisite for this migration.

**Finding:** A proprietary implementation appears feasible without replacing every underlying library. The main known copyleft components are Go.Cam's application/workflow code, the bundled GPL QR generator, and the separately AGPL-labeled WordPress plugin. Face-model commercial rights and GeoLite database terms need additional review. Publishing AGPL source would not resolve unrelated model or data restrictions.

## What was examined

- Active entry points: `server/index.mjs`, `server/app.mjs`, `web/app.js`, `web/check.html`, `script/build.mjs`, and the Supabase store function.
- Go.Cam source and compiled browser assets, the retained original backend, document templates, camera and verification wrappers, and inherited styles/artwork.
- Root `package-lock.json`: 474 dependency instances, including platform-specific optional packages; 444 installed manifests were available and 30 absent optional packages used lock metadata. All installed versions matched the lockfile. There are 38 direct dependencies: 20 declared runtime and 18 development dependencies. Some declared runtime entries are actually build tools or legacy dependencies.
- Standalone browser vendor files, all 18 face-model manifests/shards, both OCR language files, icon fonts, examples, WordPress integration, and Docker packaging.
- Public upstream licenses, exact release artifacts, and GitHub file-tree hashes. Machine-readable evidence and source URLs are in [license-audit/inventory.json](license-audit/inventory.json); direct dependency versions are in [license-audit/npm-direct.md](license-audit/npm-direct.md).

Scope limits: this is not a complete binary/container SBOM or a scan of the running deployment. Hosted account agreements, every dependency embedded inside prebuilt vendor binaries, and the legacy example application's full dependency closure have not been cleared. No inference about unpublished commercial permissions is made. Training data are not present locally; their terms were examined because upstream documents identify them as sources for bundled models.

## Application and verification components

“Retain candidate” means the component's own identified license generally permits use in a proprietary product with its conditions met. It does not authorize copying the AGPL wrapper that currently calls it.

| Component / purpose | Current evidence | License or status | Proprietary-path assessment |
|---|---|---|---|
| Go.Cam verification framework, page transitions, events and result workflows | `source/frontend/js/app/avs.js/`, `avsFactory.js/`, `common.js/`; root `LICENSE`; upstream Git remote | AGPL-3.0 declared at project level | Replace independently, obtain adequate separate permission, or retain under AGPL. Moving files or renaming classes is not relicensing. |
| Camera access and device switching | Go.Cam camera wrappers, webcam helpers, browser media APIs | Go.Cam implementation is AGPL; browser APIs are interfaces, not code copied from Go.Cam | Reimplement the wrapper using browser APIs; WebRTC adapter can remain under its own BSD license. |
| Smile/expression checks, repeated estimates, face consistency, threshold decisions | Go.Cam selfie workflow plus `faceApi.ts` | AGPL orchestration; separate MIT inference library and model questions below | Replace orchestration. No separately licensed, independent anti-spoofing library was found in the active flow. This row does not certify the checks' effectiveness. |
| ID image capture, crop/review, OCR orchestration, date extraction and document rules | `scanIdAgeVerificationPage/`, `avs.js/plugin/library/ml/tesseract.ts`, helpers and `avs.js/config/scanId.ts` | Inherited/modified Go.Cam code under root AGPL declaration; new contributions require provenance review | Reimplement inherited workflows and parsing/template code independently. Do not confuse permissive Tesseract with its AGPL integration layer. |
| Original backend and Twig pages | `source/backend/`, `app/backend/`, `app/frontend/views/` | Go.Cam AGPL; current start scripts use the new server | Not active as the primary server, but still present in the repository and copied into Docker. Exclude from a future proprietary distribution unless properly licensed. |
| TrustBunny accounts, dashboards, sessions, signing, webhooks, reusable passes | `server/`, `web/`, `supabase/`, `public/gate.js` | Newly added areas, but repository currently declares AGPL; no separate proprietary grant or complete authorship audit | Potential retention candidates after authorship, copied-code and combined-work review. Being in a new folder does not prove independence. |
| WordPress connector | `wordpress/trustverify/trustverify.php:6` | Explicit `AGPL-3.0-or-later` header | Separate licensing decision required. A legitimately separate open-source connector can coexist with a proprietary hosted API; WordPress compatibility and distribution obligations still need review. |
| Integration examples | `example/nodejs/package.json` says ISC; repository otherwise AGPL; upstream points to a separate MIT examples repository | Mixed declarations/provenance | Prefer a documented independent connector or the separately MIT-licensed upstream examples after inspection. Their license does not cover the engine. |

The [Go.Cam repository](https://github.com/Godotcam/goCamOpenSource) labels its implementation AGPL and points separately to [MIT integration examples](https://github.com/Godotcam/goCamOpenSourceExamples). Under [AGPL section 13](https://www.gnu.org/licenses/agpl-3.0.en.html#section13), network users of a covered modified version must receive a prominent source offer. Browser delivery also raises distribution obligations. Precisely how far obligations extend into TrustBunny's new code is a combined-work legal question, not settled by this inventory.

The [WordPress project's licensing explanation](https://wordpress.org/about/license/) states its position that plugins are derivative works. This is not a reason to assume a separate API service automatically inherits the connector's license.

## Browser libraries and OCR

| Component | Version / evidence | License | Assessment |
|---|---|---|---|
| Face inference library | `@vladmandic/face-api` **1.7.12**; local bundle is an exact SHA-256 match to the published release | MIT; bundled TensorFlow.js has its own Apache terms | Retain candidate when obtained directly from upstream with notices. The Go.Cam `faceApi.ts` wrapper is a different, AGPL component. |
| TensorFlow.js / WASM backend | Release package references TFJS 4.7.0; bundled SIMD WASM is an exact match to `@tensorflow/tfjs-backend-wasm@4.7.0` | Apache-2.0; embedded dependency notices also matter | Retain candidate. Restore upstream license/notice materials instead of relying solely on the minified bundle's header. |
| Legacy face-api.js | Folder labeled **0.21.0**; retained, not loaded by active `web/check.html` | Upstream MIT, with embedded Apache notices | Remove unused copy in a cleanup; its model files are assessed independently below. Exact legacy release artifact was not compared. |
| Tesseract.js browser library, worker, core and English/French data | **2.1.1** / core **2.2.0** / tessdata 4.0.0_best | Apache-2.0 | **Removed from the active candidate on October 19, 2026** (replaced by Indra OCR below). Historical Go.Cam copies under `app/` remain migration evidence only. |
| ONNX Runtime Web | **onnxruntime-web 1.30.0**: `ort.wasm.min.js`, `ort-wasm-simd-threaded.mjs`/`.wasm`, hash-pinned from the npm release | MIT | Retain candidate; notice in `vendor/verification/licenses/onnxruntime-MIT.txt`. Embedded native dependency notices are not separately certified. |
| Indra OCR port | `web/verification/ocr.ts` ports detection, deskew and recognition logic from datalab-to/indra **v1.1.1** | Apache-2.0 (code) | Derivative of Apache-2.0 code: the file states its origin and modifications; licence text in `vendor/verification/licenses/Indra-OCR-code-Apache-2.0.txt`. |
| Indra OCR weights | `det.onnx`, `rec.onnx`, `meta.json` from Hugging Face `datalab-to/indra-ocr` commit `bd02167f` (the package's `v1.1.0` model tag), hash-pinned | **Modified OpenRAIL-M** | **Owner reported approval on October 19, 2026**; `script/audit-core.mjs` now accepts this licence for vendor artifacts only. The obligations below still apply. Attachment A forbids use if the entity (or affiliate) had more than US$20M gross revenue in the prior year or raised more than US$20M, unless personal/research use, or if it offers a product competing with Datalab's. Serving the weights to visitors' browsers is Distribution: the use restrictions must be included as enforceable terms in agreements governing use/distribution, recipients must receive the licence, attribution (credit, link, licence copy, changes) is required, and share-alike applies to copies and Output. Commercial terms are available from Datalab. Licence text in `vendor/verification/licenses/Indra-OCR-weights-OpenRAIL-M.txt`. |
| QR generator | Local banner identifies **qr-js 1.1.4** and jsqrencode; loaded by `web/check.html` | GPLv3 in local headers; upstream 1.1.4 license permits version 3 or later | Replace for a straightforward proprietary browser implementation. Local minified file differs from the published npm artifact; provenance/modifications need preservation if retained. |
| jQuery | **3.5.1** banner | MIT | Retain candidate; preserve license and copyright. |
| WebRTC adapter | Folder **7.6.4**; upstream versioned license checked | BSD-3-Clause | Retain candidate. |
| Base64 utility | js-base64 **3.5.2**, version and license in source | BSD-3-Clause | Retain candidate. |
| Bootstrap | **5.0.2** in bundled CSS/JS headers; used in legacy views, not loaded directly by the active check page | MIT | Retain if needed or omit unused legacy assets. |

Primary evidence: [face-api 1.7.12 license](https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/LICENSE), [TensorFlow.js license](https://github.com/tensorflow/tfjs/blob/master/LICENSE), [Tesseract.js 2.1.1 license](https://cdn.jsdelivr.net/npm/tesseract.js@2.1.1/LICENSE.md), [OCR core 2.2.0 license](https://cdn.jsdelivr.net/npm/tesseract.js-core@2.2.0/LICENSE), [tessdata license](https://github.com/naptha/tessdata/blob/gh-pages/LICENSE), [QR 1.1.4 license](https://cdn.jsdelivr.net/npm/qr-js@1.1.4/LICENSE.md), [adapter 7.6.4 license](https://cdn.jsdelivr.net/npm/webrtc-adapter@7.6.4/LICENSE.md).

One concrete QR replacement candidate is [soldair/node-qrcode](https://github.com/soldair/node-qrcode), whose [license is MIT](https://github.com/soldair/node-qrcode/blob/master/license). It is not installed or functionally evaluated by this audit.

## Face-model files: confirmed provenance, separate commercial-rights review

All **18** local manifests and shards in `app/frontend/static/js/appFiles/faw/` match Git blob IDs in the original `justadudewhohacks/face-api.js` repository's `weights/` directory. Several weight blobs also match the newer fork's renamed `.bin` files. This establishes artifact provenance, not a guarantee of every underlying right.

The [original repository license is MIT](https://github.com/justadudewhohacks/face-api.js/blob/master/LICENSE). Its [model documentation](https://github.com/justadudewhohacks/face-api.js#available-models) provides the following training/provenance information:

| Model family | Role here | Evidence / remaining issue | Decision |
|---|---|---|---|
| `age_gender_model` | Selfie age estimate | Upstream identifies UTK, FGNET, ChaLearn, Wiki, IMDB, CACD, MegaAge and MegaAge-Asian training/testing sources. | **Commercial-rights review needed before treating as cleared.** |
| `tiny_face_detector_model` | Default selfie/document face detector | Upstream describes a custom roughly 14,000-image dataset without a complete rights chain. | MIT repository provenance confirmed; retain only after appropriate model-rights assessment. |
| `ssd_mobilenetv1_model` | Optional precise detector | Upstream credits yeephycho and WIDER FACE; yeephycho repository has Apache-2.0 license. | Model/data provenance needs review if this option is retained. |
| `face_landmark_68_model` | Alignment in active flows | Upstream describes roughly 35,000 training images but does not fully identify their licenses. | Review model rights. Do not automatically assign the license of a similarly named dlib landmark model. |
| `face_landmark_68_tiny_model` | Retained alternative | Same provenance caveat; not the landmark variant loaded by inspected active flow. | Omit if unnecessary, otherwise review. |
| `face_recognition_model` | Face matching/consistency | Upstream credits Davis King's dlib network/weights. [Dlib model documentation](https://github.com/davisking/dlib-models) provides a public-domain statement, and also describes external datasets. | Stronger model permission evidence, but not a blanket warranty of third-party training rights. |
| `face_expression_model` | Smile/expression checks | Upstream describes public datasets and scraped web images without a complete rights record. | Review model rights. |
| `mtcnn_model` | Retained legacy assets | Exact original-repository match; not selected by the inspected active detector code. | Omit unused assets in a replacement; otherwise investigate its model provenance. |

The [UTKFace publisher](https://susanqq.github.io/UTKFace/) limits its dataset to non-commercial research. The [IMDB-WIKI publisher](https://data.vision.ee.ethz.ch/cvl/rrothe/imdb-wiki/) limits its dataset to academic research and says the image copyrights remain with their original owners.

**This audit does not conclude that these dataset terms automatically make all resulting model weights non-commercial.** That depends on the permissions, rights and facts of model creation and use. It does mean the available MIT repository license alone is insufficient evidence for a confident commercial-rights clearance. Ask the model maintainer/rightsholders for clarification or choose weights supplied with documented commercial permissions. Open-sourcing TrustBunny would not by itself answer this question.

## Server, authentication, database and geolocation

| Component | Exact local version / evidence | License | Assessment |
|---|---|---|---|
| Express and HTTP middleware | express 4.22.3; cookie-parser 1.4.7; helmet 8.3.0; express-rate-limit 8.7.0 | MIT | Retain candidates. |
| Passkeys | @simplewebauthn/browser 14.0.0; @simplewebauthn/server 14.0.2 | MIT | Retain candidates. Browser/OS passkey APIs are not AGPL code. |
| Signing and validation | jose 6.2.12; zod 4.6.5; cbor-x 1.6.6; ipaddr.js 2.5.0 | MIT | Retain candidates. |
| Environment loading | dotenv 17.2.0 | BSD-2-Clause | Retain candidate; this version is BSD, not assumed MIT. |
| User-agent/device parsing | ua-parser-js 1.0.37 | MIT, confirmed in installed license | Retain candidate **at the audited version**. Version 2 has different AGPL/PRO licensing. |
| GeoIP lookup code | geoip-lite 2.0.3 | Apache-2.0 for code | Retain code if data terms can also be satisfied. |
| GeoIP database | Packaged GeoLite binaries and potential future MaxMind updates | Packaged notice says CC-BY-SA-4.0; current GeoLite EULA adds terms | **Separate data review needed**: attribution, acquisition/update rights, age of data, distribution and applicable agreement. Not an automatic source-release obligation for unrelated app code. |
| Supabase JavaScript client | Edge function imports `npm:@supabase/supabase-js@2` | Upstream MIT | Retain candidate. Exact deployed version is not pinned/known from local files; `@2` resolved to 2.116.0 during this research, not proof of the deployed version. Pin and preserve the deployment lock/metadata. |
| Hosted database | Supabase-hosted Postgres, per application architecture | PostgreSQL permissive license; separate hosted-service agreement | Using the hosted database is not itself a requirement to publish TrustBunny source. No self-hosted Supabase stack or installed extensions were audited. |
| Build tooling | TypeScript 5.8.3; esbuild 0.28.2; Gulp 5.0.0; Sass 1.76.0; remaining exact versions in inventory | Apache-2.0 for TypeScript; predominantly MIT/ISC for other tools | Generally retain. Root Dockerfile copies build-time node_modules into the runtime image, so distribution review cannot simply omit dev packages. |
| Node/container base | `node:22-bookworm-slim`, no immutable digest pinned | Node is MIT with separately licensed bundled components; Debian contains multiple licenses | Does not by itself force TrustBunny source release. A redistributable image needs an actual digest-specific OS/binary SBOM and applicable notices/source arrangements. Not cleared by the npm scan. |

Sources: installed licenses named in the inventory; [UAParser current documentation](https://docs.uaparser.dev/); [GeoIP project](https://github.com/geoip-lite/node-geoip); [MaxMind GeoLite EULA](https://www.maxmind.com/en/geolite/eula); [Supabase client license](https://github.com/supabase/supabase-js/blob/master/LICENSE); [PostgreSQL license](https://www.postgresql.org/about/licence/).

The packaged GeoLite notice and the current EULA should not be conflated. Establish which database snapshot was acquired under which terms. The current EULA requires attribution and timely database updates/deletion of obsolete versions; redistributing an image containing the data requires additional review. Do not infer legal clearance merely from `geoip-lite`'s Apache package metadata.

## Styling, icons and branding

| Asset | Evidence | Assessment |
|---|---|---|
| Font Awesome 4.7.0 CSS | Active check page loads it; header identifies MIT | Retain with applicable notices. |
| Font Awesome font files | CSS loads bundled woff/woff2/ttf/eot/svg fonts | SIL OFL-1.1. Permits embedding in commercial software subject to its conditions; does not require release of unrelated application source. Preserve font license materials. |
| Go.Cam styles, icon sprite, selfie/ID illustrations | Active `web/check.html` references `main.css`, `iconPack.svg`, `selfie-icon.svg`, `scanid-icon.svg`; no separate permissive artwork license located | Treat as inherited assets requiring replacement or separate permission on the proprietary path. Root AGPL does not establish that Go.Cam owned every third-party artwork right. |
| Old certification logos, photos and Go.Cam branding | Retained under `app/frontend/static/img/` | Not evidence of permission to claim certifications or reuse trademarks. Omit unused material; resolve rights for anything retained. |
| TrustBunny bunny logo and favicon | New SVG files in `public/assets/`; use system text fonts | No external asset/license declaration found in these files. Confirm authorship/provenance separately; lack of a notice is not a rights guarantee. |

The [Font Awesome v4 license page](https://fontawesome.com/v4/license/) distinguishes the OFL font license, MIT code license and CC-BY-3.0 documentation license. These should not be replaced by a single blanket AGPL notice.

## Npm findings and notice gaps

After normalizing older object-form metadata, the 474 locked dependency instances declare **430 MIT, 29 ISC, 7 BSD-3-Clause, 5 Apache-2.0, 1 BSD-2-Clause, and 2 0BSD** licenses. None declares GPL/AGPL. This excludes the root application's own AGPL declaration, directly vendored assets, model/data terms and the unpinned Edge import. It is a metadata scan, not a line-by-line authorship determination or every embedded-license review.

`compass-importer`, `gulp-clean`, and `gulp-typescript` declare permissive licenses but lack a top-level installed license file. Some other packages embed notices in README files instead. Root package metadata alone is not a complete third-party notice bundle. Most copied browser libraries/models also lack their corresponding full license text beside the copied files. Preserve/recover exact-version upstream licenses and required attribution before packaging a release. This audit report is not a substitute for those notices.

## Recommended next steps

1. **Keep Go.Cam and QR copyleft obligations in force for existing covered versions.** Do not remove license notices or assume a planned rewrite cures earlier distribution or network-source obligations.
2. **Resolve the age-model rights first.** Obtain documented commercial permission or choose a model/provider with an adequate rights grant. This choice may materially change the replacement architecture.
3. **Scope independent replacement of Go.Cam's workflows, document rules, wrappers, templates and inherited artwork.** Review original TrustBunny code for retention separately. Reacquire permissive libraries directly from their own upstream releases with hashes and notices.
4. **Replace the GPL QR generator.** This is a comparatively small implementation change; the MIT candidate above warrants evaluation.
5. **Resolve MaxMind database terms and provenance.** Alternatively choose a geolocation source whose service/data agreement fits the actual use.
6. **Decide connector licensing independently.** An intentionally open-source WordPress/plugin or SDK can be useful without publishing an independently implemented hosted service. Have the intended separation and notices reviewed.
7. **Pin the Edge client and release/container inputs, and assemble third-party notices.** Audit every model, dataset, downloaded asset and vendored binary in addition to npm packages. Gate future license changes such as UAParser 1.x to 2.x.

The evidence supports a targeted replacement plan. It does not support simply deleting Go.Cam attribution, declaring the current repository proprietary, or claiming that every model/data asset has been commercially cleared.
