# Document-reader diagnostics

## Independent-engine update — September 19, 2026

The new candidate uses `web/verification/diagnostics.ts`. In browser developer tools, `TrustBunnyDiagnostics.report()` returns at most 256 allowlisted stage/status/count entries held in memory. A new attempt clears them. Raw OCR text, DOB, images, descriptors, tokens and arbitrary exception messages are excluded. The reader exposes `loading-reader`, `preparing-image` (per attempt), `recognizing` progress, `date-check` retries and the final `document-result`; it does not upload this report. Since the October 19, 2026 switch to Indra OCR there are no separate language-loading or segmentation-configuration stages. See [implementation status](REWORK_STATUS.md) and [document coverage](DOCUMENT_COVERAGE.md) for current validation limits.

The remaining sections record the historical Go.Cam engine's troubleshooting and validation. Its `Avs.*` commands and file paths are not active in the independent candidate.

Reload the verification page to load the updated engine. In browser developer tools, open **Console**, enable **Info**, **Warnings**, **Errors**, and **Preserve log**, then filter for `[TrustBunny][document]`. Retry the ID scan. Preserve log keeps the diagnostic trail when verification redirects.

Each line is a snapshot with a `stage` and `status`. Relevant lines include duration, attempt number, document-layout variant index, enhancement profile, selected language, page segmentation mode, template year, crop dimensions, OCR character count, or matched rule index. Failed and retryable steps include a stable `code` and an explanation. Expected retries use Info level to avoid DevTools attaching a long asynchronous warning stack to each attempt; terminal failures remain Errors. No debug flag is required.

| Stage / code | Meaning |
| --- | --- |
| `asset-preload` | OCR worker, core, or language download; failed HTTP requests include status and a fixed asset label. |
| `worker-create`, `worker-load` | Browser library and worker startup. |
| `language-load`, `language-init` | Language download and initialization. |
| `worker-configure` | Applying the selected document's OCR parameters. |
| `face-*-model`, `face-extract`, `face-compare` | Model loading, locating the document face, and matching it to the selfie. |
| `image-crop` / `INVALID_IMAGE` | Empty/invalid crop, or a date region entirely outside the image. |
| `image-crop` / `CROP_CLIPPED` | Part of the date region falls outside the image. Recognition still tries the visible portion. |
| `image-preprocess` | Grayscale, brightness, and contrast preparation. |
| `ocr-recognize` | Worker text recognition, including progress and duration. |
| `ocr-text` / `EMPTY_TEXT` | Recognition completed but found no text. |
| `date-match` / `NO_DATE_MATCH` | Text was found but did not match any configured date rule. |
| `date-parse` / `INVALID_DATE` | Date captures did not form a valid, non-future calendar date. |
| `INVALID_CONFIG` | Invalid language, OCR configuration, date rule, or capture positions. |
| `TIMEOUT` | An OCR operation exceeded 90 seconds. The worker is terminated and verification fails explicitly. |
| `security-policy` / `CSP_BLOCKED` | The page reported a script, worker, or connection policy violation. Correlate with browser CSP errors; another page script can also trigger this event. |
| `document-result` | Final verification outcome; failures include the numeric application error code. |

A `start` without a matching completion locates a stalled operation. OCR operations have a timeout; model loading and face processing may require checking Network/browser errors when stalled. A `retry` is diagnostic, not a final rejection: the reader cycles through document variants and image adjustments. The first `failure` generally identifies the cause; `document-result` summarizes it.

Application failure codes 25070–25073 distinguish an unavailable image, failed OCR configuration, failed image preparation, and fatal text-reader failure. Existing 25051–25054 identify missing face, face mismatch, age below threshold, and exhausted OCR attempts.

Diagnostics remain in the browser console. The logger uses an explicit runtime allowlist and never prints document pixels, OCR text, names, birth dates, calculated ages, biometric descriptors, session tokens, or raw exception messages/stacks. It does not upload diagnostics or store them in the database or browser storage. Keep the legacy generic logger disabled: its old callers include private content.

Validation: `node --test tests/ocr-diagnostics.test.mjs` covers redaction, worker failures, duplicate/late callbacks, timeouts, failed configuration, malformed results/rules, empty text, unmatched text, and invalid dates. A separate browser smoke check successfully recognized and parsed synthetic date text with the bundled English and French models under the app's current security policy. This does not establish accuracy on a real identity document or a particular layout.

## Florida license reading changes

The uploaded diagnostic log showed successful initialization and 48 completed recognition calls: 43 unmatched date patterns and five empty text results, without a worker failure. This narrows the problem to reading/matching the selected region; it does not prove which part of the real image was unreadable.

English-language document layouts now use the English model. Each layout is first tried with its original pixels and a stable crop. Later attempts use repeatable grayscale/contrast profiles and bounded crop-scale adjustments instead of random changes on every pass. The cropped text uses block/line segmentation (6/7), unless a layout explicitly overrides it. Both configured Florida templates retain their existing US month/day ordering and date formats.

All OCR events now inherit the attempt, variant, and profile, so a text failure can be traced back to its crop. The final result includes retry totals. For a compact copy without DevTools stacks, run `Avs.Debug.DocumentDiagnostics.getReport()` in the console **on the verification page before navigating away**. This returns at most 1,000 sanitized lines held only in memory; a new scan clears the report.

The camera capability probe no longer requests audio and stops its temporary video tracks. The microphone policy warning was separate from the date-reading failures.

Browser validation: all eight synthetic Florida crop → OCR → date-parsing checks passed (two templates × four image profiles) with the bundled worker under the application CSP. A real-document retry is still needed to assess the reported license image.

## Local crop recovery

If the automatic crop cannot produce a date after four profiles per layout (eight attempts for Florida), reading pauses before recording a terminal failure. The visitor sees the selected region on their existing photo and a close-up preview. They can draw a new rectangle or use labeled keyboard-accessible sliders, then choose **Read selected area**. The selected rectangle stays fixed as OCR retries the configured date formats and image profiles.

The crop controls select pixels only. They do not accept an entered birth date or bypass face checks, OCR parsing, or the required-age decision. Unreadable selected regions return to crop review after another bounded round. **Cancel verification** records failure; **Start over with a new photo** reloads the current pending verification flow.

`CROP_REVIEW` means reading is waiting for the visitor, and `CROP_SELECTED` marks resumed reading. `cropMode` distinguishes automatic from selected regions. The photo and previews are canvas-only, remain in browser memory, and are never included in diagnostics, uploads, or storage.

Recovery validation: browser tests exercised an intentionally misplaced synthetic date through eight empty automatic crops, keyboard crop adjustment, real OCR, and date parsing. The adult fixture recovered successfully; the underage fixture was rejected with 25053. Face coordinates were simulated for these focused crop tests; no real identity image or server verification result was used.

## ID screen illumination

The live ID capture screen uses a compact preview high in the center, with white screen space along both sides and below it. Screen light is enabled at full pixel intensity by default, with a toggle and an intensity slider. Device brightness remains under the visitor's control. The screen light is useful when the document faces the screen; it does not control the camera's hardware torch.

Capture now maps the guide's viewport coordinates through the preview's `object-fit: cover` transform to native video pixels, including mirrored previews. A focused regression test covers offset previews, portrait framing, mirroring, and a camera that is not ready. In browser verification, a 380px preview captured a 1501×932 region from a synthetic 1920×1080 stream. Actual improvement in grain depends on the display, camera, distance, and ambient light.
