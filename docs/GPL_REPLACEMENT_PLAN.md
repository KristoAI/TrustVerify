# TrustBunny core GPL/AGPL replacement plan

Prepared September 19, 2026 from the current working tree and [component audit](LICENSE_AUDIT.md). Status: the independent core candidate is implemented; see [current validation and remaining acceptance](REWORK_STATUS.md). Historical licensing remains unchanged.

The owner subsequently corrected the verification requirements: document checks must never require a selfie or portrait comparison. The current three-mode behavior and threshold are recorded in [implementation status](REWORK_STATUS.md#corrected-verification-modes); they supersede the earlier matching/threshold assumptions below.

## Objective and agreed scope

Produce a core service release with no Go.Cam GPL/AGPL implementation or GPL QR generator in its application source, browser bundles, served assets, or application package. Preserve the existing TrustBunny product behavior, integrations, privacy boundary, and branding.

The owner also requests a working **Continue on your phone** QR path. This is an explicit addition to the currently disabled legacy feature and is required for the replacement release. The detailed design and acceptance checks are in [QR continuation plan](QR_CONTINUATION_PLAN.md).

The owner reports that counsel supports retaining the recognition libraries/models for this use case. This plan adopts that direction: retain the audited face-api, TensorFlow.js, and model artifacts with their identified notices and provenance. Model replacement is not a prerequisite for this migration. This records an implementation decision based on the owner's report, not a new legal conclusion about all AI training data.

The WordPress plugin is explicitly excluded from replacement. Keep its existing license and maintain its API compatibility. Package it separately from the core runtime. Node/Debian system packages may have their own copyleft licenses; the target is a core application without GPL/AGPL components, not a claim that every operating-system utility is permissively licensed. GeoLite data terms remain a separate item from the earlier audit and do not expand this rewrite.

## Recommended approach

Write a small, independent browser verification application in TypeScript with native DOM/browser APIs, built by the existing esbuild pipeline. Integrate the retained inference/OCR libraries directly. Keep library versions and model bytes stable during the migration so behavior changes can be attributed to the new application code. No framework or hosting migration is needed.

Implement from a written behavior specification, our service protocol, and the permissive libraries' documented APIs. Do not translate Go.Cam classes, copy its helpers/configuration, or feed its implementation into a line-by-line rewrite. Code has already been inspected for this audit, so this plan does not claim a formal clean-room process. Record the origin of retained first-party modules and independently developed rules; use counsel's chosen provenance standard for the final licensing decision.

The work is concentrated, but the document reader is substantial: `source/frontend/js/app/` contains 206 files and approximately 37,677 lines, of which 20,498 are in `avs.js/config/scanId.ts`. Many files are framework/UI plumbing that need not be recreated. The existing server is ten files and approximately 2,158 lines; its service architecture can largely remain, subject to the retention review below. Line counts describe scope, not a delivery estimate.

## Replacement map

| Existing area | Action | Proposed destination / result |
|---|---|---|
| `source/frontend/js/app/avs.js/` and `avsFactory.js/` | Replace inherited engine, wrappers, event framework and workflows | `web/verification/` with explicit camera, inference, OCR, UI and session modules |
| `source/frontend/js/app/common.js/` | Replace inherited bootstrap, token bridge, translations and helpers | Independent bootstrap and completion client; retain required behavior only |
| `web/check.html` | Rebuild inherited page structure and content | Small TrustBunny-owned page shell, accessible method selection and progress/error views |
| `source/frontend/css/`, `app/frontend/static/css/main.css` | Replace inherited styling | New verification stylesheet; review `public/assets/check.css` for original reusable styling and dependencies on the old DOM |
| Go.Cam icon sprite, ID/selfie illustrations, legacy logos and certification images | Replace active artwork; omit unused material | Original TrustBunny artwork or independently sourced permissive icons with notices |
| `app/frontend/static/js/vendor/qr-code/v1ncc/` and inherited QR wrappers | Replace GPL encoder/wrappers and disabled continuation code | Independently implemented desktop/phone handoff, using a pinned permissive QR encoder |
| `avs.js/config/scanId.ts` | Independently reconstruct supported document rules | A new documented rules format with provenance and fixtures; no automatic conversion of the inherited table |
| Original `source/backend/`, `app/backend/`, Twig views and inherited iframe SDKs | Retire from the new core source/package after confirming no required callers | Existing TrustBunny server, gate and examples supply the supported integration surface |
| `app/frontend/static/js/app/` and old asset tree | Stop building/serving; remove from final core artifact | Only approved new bundles and directly sourced vendor/model assets |
| `server/`, `web/app.js`, `web/pages.mjs`, `web/styles.css`, `public/gate.js`, `supabase/`, `examples/` | Review authorship and copied fragments, then retain original portions | Existing accounts, policy, signing, passes, webhook, persistence and SDK functionality |
| `tests/ocr-diagnostics.test.mjs` | Preserve behavioral requirements; replace legacy namespace/source-loader coupling | Tests against independent module interfaces and synthetic fixtures |
| `script/build.mjs`, `script/gulpfile.js`, package scripts, Docker packaging | Remove dependence on legacy build; audit inherited build code | esbuild frontend and explicit core runtime packaging |
| `wordpress/` | Leave implementation/license unchanged | Separate plugin artifact using the same service contract |

Retain permissive third-party code by obtaining it from its own upstream release with exact versions, hashes, licenses and required notices. This includes face-api 1.7.12, the matched TensorFlow.js WASM, Tesseract.js 2.1.1/core 2.2.0, English/French OCR data, and WebRTC adapter if needed. Existing server/passkey libraries remain candidates to keep. jQuery, js-base64, Bootstrap and Font Awesome can be omitted where the new UI does not need them; their permissive licenses do not require a rewrite.

## Implementation sequence

### 1. Establish the behavior and provenance baseline

- Inventory the currently selectable methods, countries, subdivisions, document types and layout variants. Distinguish a selectable configuration from a document layout actually validated on samples.
- Write a parity checklist for selfie, document, fallback, crop recovery, cancellation, failure and completion. Capture UI behavior without importing the old implementation into the new modules.
- Review original TrustBunny areas against upstream and their available history. Classify retained original code, copied/derived portions to replace, third-party components, and unresolved provenance. A different folder or new filename is not enough evidence on its own.
- Record the baseline result of existing offline tests and which integration/device checks remain unrun. Do not treat the real-Supabase integration suite's default skip as a pass.
- Create synthetic/non-identifying OCR fixtures and appropriately permissioned camera fixtures; retain no visitor identity documents as migration test data.

Deliverable: a behavior matrix, document coverage matrix, retained-file manifest, and baseline verification results. Full currently offered document coverage is the default migration scope; any proposed reduction must be called out explicitly rather than silently removed.

### 2. Build the independent page and service bridge

Proposed modules under `web/verification/`:

| Module | Responsibility |
|---|---|
| `index.ts`, `flow.ts`, `ui.ts` | Bootstrap, explicit flow states, accessible rendering, retries and cleanup |
| `camera.ts`, `capture.ts` | Video-only permissions, device switching, stream lifecycle, native-pixel capture and mirroring |
| `models.ts`, `face.ts`, `selfie.ts` | Load retained models, expose inference results, enforce the selected selfie policy |
| `ocr.ts`, `document.ts`, `dates.ts`, `crop-review.ts` | Worker lifecycle, document recognition, validated date handling and recovery |
| `document-rules/` | Independently authored, versioned layout/date rules with evidence |
| `session.ts` | Session-bound outcome submission and completion navigation |
| `continuation.ts`, `qr.ts` | Desktop/phone pairing UI, QR rendering, status checks and desktop resumption; paired server routes/state described in the continuation plan |
| `diagnostics.ts` | Bounded in-memory, allowlisted operational events without verification input data |

These are responsibility boundaries, not a requirement to recreate the old class hierarchy. Use a new asset entry such as `/assets/verification.js` and approved `/assets/vendor/` and `/assets/models/` paths.

Replace `server/app.mjs`'s legacy `AvsToken.main`, base64 success/failure token envelope, `scanId` naming and `partnerColorConfig` page configuration with minimal JSON configuration: session ID, completion capability, permitted methods, required age and validated branding. Keep JSON script embedding escaped safely; capability values must not enter logs or analytics.

For the first working slice, preserve the current server completion contract without changing merchant integrations:

- `POST /result/success` or `/result/fail` with the bound `token`, `sessionId`, and `stepId` (`3` for selfie, `5` for document).
- Read `content.completionUrl` and continue through the existing one-use `/complete/:id?handoff=...` flow. Validate the destination against the expected service origin/path before navigation.
- Optional document/device fields need not be sent. Images, text, DOB, exact ages and descriptors stay in browser memory.
- Preserve current outcome semantics: `/result/fail` records `inconclusive`. Do not silently introduce a new public outcome taxonomy during this migration.

The numeric step IDs can remain a tiny compatibility detail inside the new client. A later API cleanup is separate work. The completion route's implementation is part of the first-party provenance review, even though its wire contract is retained.

That existing bridge is the single-device baseline. QR continuation additionally needs separate desktop/phone permissions, atomic handoff state, a status endpoint that remains usable after session completion, and desktop-bound result delivery. Do not simply put the existing launch capability into the QR code or let both devices consume the same completion handoff.

Deliverable: an independently rendered page connected to test session completion, with safe cancellation and asset loading. No temporary test bypass is enabled in production.

### 3. Replace camera and selfie workflows

- Implement camera setup/switching, orientation/mirroring, readiness, permission failures and guaranteed track cleanup on exit/retry.
- Call face-api directly. Preserve required face presence, sample consistency, smile/expression sequence, bounded attempts and timeouts using new orchestration.
- Preserve the currently effective selfie age rule during parity testing: `max(25, requiredAge + 7)`. Record this as a behavior baseline, not a newly validated scientific threshold. Centralize the policy so changes are deliberate and separately evaluated.
- Preserve document fallback when the site allows it. A site that permits only one method must not gain an unapproved alternative.
- Release tensors, canvases and workers/streams where applicable; ignore late asynchronous results after cancellation or a new attempt.

Deliverable: a complete selfie-to-result journey using the existing models, with consistent policy enforcement and no Go.Cam runtime calls.

### 4. Replace document capture and reading

This is the largest and most uncertain work package.

- Rebuild capture, image upload where currently offered, native-pixel crop mapping, preview, face comparison and DOB extraction using the retained libraries directly.
- Independently author document rules using adequately permitted reference material and observations. Record rule origin, date order, region/layout, validation fixtures and coverage status. Do not copy the inherited table into JSON and call it a replacement.
- Build a reusable date parser with explicit calendar validation, future-date rejection, date-order handling, leap-year and required-age birthday boundary tests. Distinguish DOB from issue/expiry dates; ambiguous output must remain inconclusive.
- Preserve the recent Florida work as requirements: English OCR, stable crops, bounded image profiles, useful sanitized diagnostics, manual region selection after exhausted automatic attempts, and repeated OCR of the chosen region. Reuse original helpers only where the provenance review supports doing so; otherwise independently implement their behavior.
- Preserve crop controls' constraint: they select pixels and never accept an entered DOB or bypass face/age checks.
- Preserve video-only camera access, compact preview/native resolution mapping, screen-light controls, keyboard crop adjustment, timeout/worker termination and retry cleanup.
- Use the two Florida layouts as the first regression slice, then complete the document coverage matrix. Synthetic date recognition proves plumbing, not real-document coverage or accuracy.

Deliverable: documented coverage parity, including local crop recovery, with inconclusive outcomes for unsupported or unreadable inputs. If replacing all currently offered layouts proves disproportionate, present a concrete reduced-coverage option as a separate product decision before cutover.

### 5. Finish UI, QR, build and package removal

- Replace all inherited screen structure, CSS, icon references, error copy, translations and generic helpers still used by the new flow. Retain the original TrustBunny logo/branding after its provenance check.
- Implement the requested QR continuation path per its dedicated plan. Replace the old wrapper instances, hidden UI and disabled polling branches with a new flow; do not reactivate the inherited implementation.
- Use a pinned release of the MIT `qrcode` package after exact-version license/dependency verification. Independently implement the pairing, server authorization and desktop completion workflow. Custom QR encoding is outside the planned scope; the library converts our continuation URL into the QR image.
- Remove the legacy compiler/Gulp invocation from `script/build.mjs`; retire inherited build/watch tasks and dependencies that are no longer used. Regenerate the lockfile through the package manager.
- Remove legacy `/static` mounts from `server/app.mjs`, including access to unused assets. Bundle/copy approved assets explicitly.
- Replace Docker's whole-repository runtime copy with an allowlist of required server files, page shells, built assets, vendor/model assets, production dependencies and notices. Exclude WordPress, old examples, legacy source/build output, tests and local data from the core image unless needed for an explicitly documented purpose.
- Remove the replaced Go.Cam source and compiled assets from the new core tree after parity checks. Preserve historical license records and source-access arrangements where applicable; do not rewrite Git history as a licensing technique.

Deliverable: a clean build and core release artifact that contains no inherited engine, GPL QR bundle, stale source maps embedding old code, or legacy served assets.

### 6. Verify, document licensing and cut over

Run checks appropriate to the replacement:

| Area | Required evidence |
|---|---|
| Existing services | Offline security/passkey tests pass; real-Supabase integration suite is explicitly run in an isolated test setup or recorded as outstanding |
| Session bridge | Allowed methods, capability binding, expiry, repeated submission, completion handoff, signed redirect, webhook and API lookup remain consistent |
| QR continuation | Scan/pair on phone, approve on desktop, complete either verification method on phone, resume original desktop; expiry, revocation, duplicate claims/completion, reconnect, isolated device cookies and unchanged merchant result binding |
| Selfie | No face/multiple faces, inconsistent face, expression sequence, age threshold boundary, fallback, model failure, cancellation and late results |
| Document | Required-age/date boundaries, invalid/ambiguous dates, face mismatch, unreadable OCR, upload/camera paths, crop recovery, mirroring and worker timeout |
| Privacy | Browser network/storage inspection shows no images, OCR text, DOB or descriptors leaving the verification flow or entering persistent storage/logs |
| Real browsers | Desktop Chrome/Safari and iOS Safari/Android Chrome camera checks, including denied permission, switching, rotation and slow asset loading |
| Assets and licenses | Dependency metadata, vendor hashes/notices, source provenance, generated bundles/maps and actual runtime image inspected; old asset URLs unavailable |
| Plugin compatibility | WordPress continues to use the preserved service interface; its implementation and license remain unchanged |

Use small behavioral unit tests and focused browser/integration tests. Do not carry forward tests whose only purpose is to assert the old namespace or class layout. Existing synthetic OCR results must not be presented as successful real-ID validation.

Review both the source tree and built artifacts against the old inventory and a license scanner. Search for inherited symbols/paths and GPL headers as supporting evidence, not as the sole proof of independence: removing a header or renaming a symbol proves nothing about provenance. Account for WordPress, historical documentation and OS packages explicitly rather than broadly suppressing GPL findings.

Assemble exact-version third-party notices and a new inventory, and present the core-file licensing/provenance manifest for counsel's final review. Update the root license, package author/license metadata, README and release notices only for code the owner has the right to license and after the replacement scope is resolved. Retained third-party code keeps its own licenses. Do not strip historical attribution from covered old versions.

Cut over in staging first, then release the verified core artifact. Temporary side-by-side development does not remove the old version's obligations. If a legacy deployment is retained for rollback, label it as the old AGPL release; after acceptance, retire its active routes/assets. No production deployment is authorized by this planning document.

## Completion criteria and practical scope

The migration is complete when both verification methods work to the recorded coverage, QR continuation returns the phone's result to the originating desktop, external integration contracts are preserved, the WordPress exception is explicit, the final core source/artifacts contain none of the replaced GPL/AGPL implementation, and the licensing/provenance record is ready for the chosen release terms.

This is a targeted browser-engine replacement, not a rebuild of the whole company platform. QR image rendering, page bootstrap and build cleanup are small tasks. Camera/selfie orchestration, UI, service bridging and the complete cross-device continuation workflow are medium tasks. The dominant variable is document-rule reconstruction and real-device/document verification. Estimate delivery after the baseline coverage inventory and first Florida slice rather than promising a short schedule from repository size alone.

Recommended first implementation milestone: complete the baseline/provenance matrix, build the independent page and session bridge, and deliver the camera/selfie flow. Then add QR pairing and desktop resumption against that working flow, extend it to document verification, and complete document parity before removing the legacy engine from the release.
