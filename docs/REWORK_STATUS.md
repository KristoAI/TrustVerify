# Independent core implementation status

September 19, 2026. This is a migration candidate, not a declaration that the historical repository has been relicensed or that document coverage has been fully validated.

See the [provenance record](CORE_PROVENANCE.md) for independently authored, retained and unresolved areas.

**Cloud update — October 17, 2026:** The hosted schema and both edge functions are now deployed. The original September implementation notes below describe their status at that time; see [current deployment status](DEPLOYMENT_STATUS.md). Node/browser hosting and email sender configuration remain separate.

## Implemented scope

- Independent browser application under `web/verification/`: native camera lifecycle, direct face-api integration, selfie orchestration, document capture/OCR/date processing, crop recovery and QR continuation UI.
- Independent QR pairing/backend transaction layer and migration `supabase/migrations/202609190001_continuation.sql`; the phone reports the outcome while completion returns to the originating desktop.
- MIT `qrcode` 1.5.4, pinned in the lockfile. The Edge bridge now pins MIT `@supabase/supabase-js` 2.116.0, with its exact-version notice and integrity recorded separately in `docs/license-audit/edge-dependency.json`. Legacy Gulp/compiler invocations and unused dependencies removed from the active build.
- Audited recognition/OCR/model artifacts reacquired directly from upstream under `vendor/verification/`, with SHA-256 verification during every build and recorded licenses. Models retained according to the owner's counsel-informed direction.
- New server configuration and page shell; the historical `/static` tree is no longer served. Only approved assets built into `dist/assets` are exposed.
- An explicit core candidate package and Docker copy allowlist exclude inherited engine source, generated legacy bundles, GPL QR code, old templates/artwork and WordPress from the runtime image.

Document ID currently remains a date-extraction development prototype. It does not authenticate a government document or protect against deliberate browser-result tampering. Manual selection requires the visitor to explicitly select one printed date; its label is optional. This path does not independently establish that the selected field is a birth date.

## Verification paths

The identification link and demo offer two paths:

- **Live AI Age Check**: a live estimate at or above `max(25, requiredAge)` can complete the check. A lower estimate is a soft fail that automatically opens Document ID before any outcome is submitted. The document result completes the same session; no intermediate failed result is recorded. Unavailable selfie checks also offer a document option.
- **Document ID**: country, issuing region and document type, then direct capture/upload and DOB reading. No selfie, face-model call or document portrait comparison.

Merchant settings permit both paths or Document ID only. Legacy selfie-only policies now include document reinforcement when read; existing database rows are not rewritten. The `selfie` demo API alias also includes reinforcement. Visitors may choose Document ID immediately when both methods are available. Country/state/type choices guide capture and reader defaults; they do not establish full document-layout coverage. No face matching is part of either document route.

## Running and checking the candidate

Requires Node.js 24 or newer. Docker pins a verified Node 24 Bookworm image digest and runs as the unprivileged `node` user.

```sh
npm ci
npm run build
npm run typecheck
npm test
npm run audit:core
npm run package:core
```

Vendor files are checked in with recorded hashes. `npm run assets:fetch` restores them from their recorded upstream URLs and rejects changed bytes. It does not silently upgrade them.

`dist/core-candidate` is a runnable allowlisted application package. Install its runtime dependencies with `npm ci --omit=dev`, supply the documented runtime environment and start with `npm start`. Its root license deliberately remains the historical license pending the final licensing decision below. Do not represent this artifact as a cleared proprietary release.

The continuation database migration and updated Edge bridge procedure/table allowlist must be applied together before using QR on an existing deployment. Apply `202609190002_document_reinforcement.sql` as well so existing selfie-only sessions can complete document reinforcement. Both migrations are applied in the isolated local preview database; they are included with the candidate package. This implementation work does not apply changes to the hosted database or deploy the service.

`tests/continuation.test.mjs` includes an opt-in isolated PostgreSQL check using `TV_CONTINUATION_DB_CONTAINER=trustbunny-...`; it never reads a production database URL. `script/verification-preview.mjs` similarly requires an explicitly named disposable test container and does not read deployment configuration. The browser fixtures use synthetic data, do not access a camera, and are excluded from the core package.

## Acceptance still required

1. **Document coverage.** The [coverage inventory](DOCUMENT_COVERAGE.md) records 420 historical configured entries across 37 countries. The independently authored reader supports labelled/selected dates and checksum-validated ICAO TD1/TD2/TD3 MRZ parsing without inheriting the layout table. It does not establish parity for those layouts. The document-only path now reads the selected DOB/MRZ side without requiring a portrait; unchecked printed two-digit years remain unsupported. Both historical Florida layouts need real-document validation. This is an explicit release blocker for a claim of full prior coverage, not an approved reduction of the product's supported IDs.
2. **Physical-device checks.** Real desktop/mobile cameras, presentation changes, lighting, OCR on permissioned ID samples and complete cross-device journeys need acceptance. Synthetic tests demonstrate mechanics, not biometric accuracy or equivalent verification performance.
3. **Hosted integration and deployment.** Local PostgreSQL tests do not prove the deployed Supabase Edge function, account configuration or hosted migrations are current. The live integration suite is opt-in and its skip must not be reported as a pass.
4. **Final licensing/provenance decision.** The working tree still retains historical Go.Cam source, compiled assets and legacy tests as migration evidence. They are not built/served/packaged by the candidate. Root `LICENSE`, package licensing and historical attribution have not been changed. After acceptance and review of original TrustBunny contributions, retire the historical source from the release source tree and choose the intended license for code the owner may license. Preserve obligations for previously covered releases and required third-party notices. WordPress remains separately AGPL.
5. **Separate terms and notices.** GeoLite data terms, model-rights direction, and container/OS licenses remain separate from replacing Go.Cam implementation. The npm/reference/hash check is not a full embedded-binary legal clearance. Generated notices include exact installed texts, embedded README licenses, and recorded upstream texts where available; `lazy@1.0.11` declares MIT but has no full notice in the installed package, so its notice provenance remains flagged in the inventory.

## Validation record

Baseline before edits: 25 offline checks passed; the live Supabase integration suite was skipped.

- Full suite with the disposable PostgreSQL container: 123 passed, 0 failed, 1 skipped (hosted Supabase). This total includes retained historical-engine regression checks; those are not evidence of replacement document-layout parity.
- TypeScript checking, independent build, asset/dependency audit and explicit core packaging passed. The audit checked 190 locked dependency declarations, 32 vendor hashes and 67 browser build inputs.
- DOB localization now uses word positions, then a focused original-pixel reread, bounded to two OCR calls before manual box selection. Local advisory quality checks offer retake/bypass. The real browser OCR worker passed a multi-column synthetic DOB/issue/expiry fixture in exactly two calls. Automatic card rectification and real-ID accuracy measurement remain outstanding.
- October 19, 2026: Tesseract.js was replaced by a browser port of Indra OCR on onnxruntime-web (see the coverage document). On synthetic fixtures the port matched the Python package's text exactly, and the English, French, selected-region, multi-column and 4°/10° tilted-card browser fixtures passed. The MRZ fixture still fails on the same country-code confusion. The Indra weights carry a modified OpenRAIL-M licence; the owner reported approval the same day, and its distribution/attribution obligations are listed in the licence audit.
- Earlier, local browser checks ran the actual Tesseract worker/core on synthetic English DOB, French DOB and selected-region fixtures. All passed under the application's asset/security setup. Retained face models loaded and blank-image inference correctly found no face. These checks do not measure accuracy on people or identity documents. A separate synthetic passport MRZ run failed because actual OCR changed or omitted characters; a bounded whitelist experiment did not fix it and was reverted. The reader correctly rejected the invalid record. MRZ parsing unit tests pass, but MRZ browser acceptance is explicitly outstanding (details in the coverage document).
- The rendered continuation QR was decoded independently and followed through phone claim, matching phrase, desktop approval, synthetic phone completion, desktop resumption and signed demo callback. Two browser tabs shared a local browser profile; distinct physical devices remain outstanding. SQL/HTTP tests separately exercise device authority, races, revocation, completion retry after an injected post-commit failure and recovery despite another tab's cookie. Four additional production-entry document journey tests use controlled hardware/OCR fixtures to verify document-only success without any face/selfie calls, underage refusal, under-25 fallback without premature submission, and upload after camera denial. Browser UI checks verified the two-path demo chooser, Florida license defaults and passport state-field hiding. A dedicated camera regression also confirms that late failure/abort from a superseded camera cannot stop its replacement.
- The Node 24 container built successfully. Inspection inside the actual image confirmed the independent assets/notices are present and legacy source, WordPress and tests are absent. Server imports and a CBOR encode/decode smoke check passed as UID 1000.
- No hosted migration, Edge deployment or production cutover was performed.
