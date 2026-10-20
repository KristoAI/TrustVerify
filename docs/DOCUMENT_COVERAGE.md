# Independent document reader: coverage and acceptance record

Prepared September 19, 2026. This is a development candidate, **not a claim of document-layout parity or production readiness**.

## Implemented scope

Country, issuing state/province/territory and driver-license/passport/ID-card choices are restored; see [document selection](DOCUMENT_SELECTION.md) for their independently authored sources and effects on capture and OCR settings.

The new `web/verification/document.ts`, `dates.ts`, `crop.ts`, `mrz.ts`, `document-locator.ts` and `document-quality.ts` are independently authored from TrustBunny's written behavior requirements, general calendar/image-processing concepts, and the primary ICAO specifications linked below. No Go.Cam code, regular expressions, coordinate tables, OCR settings tables, or layout rules were copied or translated into these modules. The legacy configuration was evaluated read-only to count the entries below, solely for the migration audit.

The reader uses Indra OCR (October 19, 2026; replaces Tesseract.js 2.1.1). `web/verification/ocr.ts` is a TypeScript port of Indra's line detection, deskew and Latin-script recognition (datalab-to/indra v1.1.1, Apache-2.0 code) running the pinned `det.onnx`/`rec.onnx` weights on onnxruntime-web 1.30.0 (WASM, one thread, inference in the runtime's proxy worker). Orientation, script routing, language-model beam search, layout and reading-order models are not used. One Latin recognizer reads English and French documents. A full image is levelled once before reading, so located fields are cropped from the same frame their word boxes describe; a selected region is levelled on its own. Detection never upscales a small image and then rescales once toward a readable line height, so tight crops read like full pages. Every input also gets a replicated border (half its shorter side, 8–64 px) before detection: on a real Florida license photo, boxes drawn tightly around the printed date otherwise broke into fragments and were never read. It reads a whole document image looking for an explicit English/French DOB label or a complete TD1, TD2 or TD3 machine-readable zone (MRZ). If automatic reading is inconclusive, a visitor may explicitly select pixels containing the printed birth date alone; its label is optional. The entire selected region must yield exactly one valid date. The caller applies the required-age decision. Per the owner's corrected requirement, document verification does not request a selfie or perform portrait matching. Region selection supplies no typed DOB or approval bypass.

Supported parsing forms are four-digit-year numeric dates with explicit `MDY`, `DMY` or `YMD` ordering, unambiguous year-first dates, and day/month-name or month-name/day dates using English/French month names. Without an explicit order, ambiguous numeric dates remain unreadable. Dates must be real Gregorian calendar dates and no later than the current UTC date. Age calculations use the UTC birthday; a February 29 birthday reaches the new age on March 1 in non-leap years. This conservative rule requires a deliberate policy change if a different jurisdictional convention is needed.

Full-image recognition now uses OCR word boxes to locate one English/French DOB label and a date to its right or below, independently of flattened text reading order. It includes both label and value in a padded region and rejects competing fields, multiple candidate dates, or unrelated words inside the crop. Damaged numeric glyphs may nominate a region for rereading, but are not corrected or accepted as the DOB by the locator. The focused reread must still parse an explicit DOB label and must agree with any valid first-pass DOB. When word layout is unavailable, the original conservative labelled-text parser remains the fallback. A **human-selected** region accepts exactly one date with or without its DOB label. Multiple dates are rejected even when one has a recognized DOB label; recognized invoice/issue/expiry labels, invalid calendar dates and unresolved date orders are rejected. A manual crop does not independently establish that the field is a birth date or that the document is genuine.

There are **at most two OCR calls per read**, including the automatic focused reread. The first automatic call reads the levelled image at its original scale. When a DOB region is located (including a bounded label-adjacent region with undecoded value text), the second rereads that crop of the levelled image with enlarged grayscale/contrast. Otherwise, the second uses the full image with that profile. Unresolved images then open manual box selection; no third automatic OCR call is scheduled. Human-selected regions remain fixed, also bounded to two calls. Conflicting dates may stop earlier. The entire reader lifecycle retains a 90-second timeout. Cancellation and failure release the inference sessions, temporary canvases and pixel buffers are cleared, and late results/progress cannot complete the abandoned attempt. OCR output/layout references are released. OCR text, images, DOB and exact ages are never logged, uploaded, or persistently stored by these modules.

Capture-quality advice checks low pixel dimensions, severely low detail, and near-blank clipped highlights using a bounded local sample. These conservative heuristics are advisory: the visitor can retake or explicitly continue with the image. They do not detect the card boundary, measure optical focus, correct perspective, or establish real-document quality. Automatic document rectification and issuer-specific layout hints remain future work.

## Independent MRZ implementation and provenance

The character values, weighting and numeric date representation come from [ICAO Doc 9303 Part 3, §§4.8–4.9](https://www.icao.int/sites/default/files/publications/DocSeries/9303_p3_cons_en.pdf). Field positions and checksum coverage come directly from §4.2.4 and the associated field directories in [Part 4 (TD3)](https://www.icao.int/sites/default/files/publications/DocSeries/9303_p4_cons_en.pdf), [Part 5 (TD1)](https://www.icao.int/sites/default/files/publications/DocSeries/9303_p5_cons_en.pdf), and [Part 6 (TD2)](https://www.icao.int/sites/default/files/publications/DocSeries/9303_p6_cons_en.pdf), accessed September 19, 2026. No third-party MRZ implementation was used. The tests include ICAO's public fictional checksum examples plus independently composed synthetic records.

The parser requires complete adjacent rows: TD1 has three rows of 30 characters; TD2 has two of 36; TD3 has two of 44. It validates document-number, DOB, expiry, applicable TD3 optional-data and composite check digits. TD1/TD2 extended document numbers are supported. Expiry fields receive basic calendar validation; accepting/rejecting an expired document is a separate product policy and is not inferred here. The whole-image reader returns only `birthDate` and `source: 'mrz'`. It does not return names or document numbers. Selected-region reading never interprets MRZ data.

Century selection is an explicit conservative TrustBunny policy, **not a claim that ICAO's two-digit year encodes a century**: choose the most recent non-future valid DOB in the previous 100 years. Required age is never an input to that choice. An encoded year `09` in 2026 resolves to 2009, never 1909 merely to pass an age gate. A centenarian's date may consequently resolve to a young person and be rejected; use a supported printed four-digit-year DOB path or another approved method. Unknown/partial DOBs fail.

OCR normalization permits whitespace/case normalization and at most four one-to-one letter-to-digit corrections inside numeric fields (`O→0`, `I/L→1`, `Z→2`, `S→5`, `B→8`). Every corrected result still needs all required checksums. Alphanumeric fields are not guessed, missing characters are not inserted, and competing distinct valid records or contradictory printed birth dates are rejected. A damaged detected MRZ remains unreadable and can be retried with another bounded image profile. Checksums have collisions and do **not** authenticate a document, prove issuer legitimacy, or replace the caller's age gate.

## Unsupported or unvalidated

- MRZ parsing is implemented, but **actual passport/ID OCR and capture coverage is not validated**. The document-only path can capture the side containing the DOB/MRZ without a portrait match. Passport capture instructions request the personal-details page and machine-readable lines. Unchecked two-digit-year printed dates, MRV visa formats, incomplete/unknown MRZ dates and nonstandard MRZ formats remain unsupported.
- No PDF417/barcode parsing, issuer-specific coordinate rules, automatic issuer/layout recognition, non-Gregorian dates, or languages beyond English/French have been implemented.
- All historical layout entries below remain **unvalidated in the new implementation**, including both Florida driver-license variants. A historical selection or synthetic date test is not evidence of a working real-ID layout.
- No permissioned real identity-document fixtures were supplied or used in this work. Camera lighting, glare, native capture framing, manual crop accessibility and real browser/device behavior need integrated validation.
- This generic/MRZ implementation reduces the amount of issuer-specific reconstruction needed, but the outstanding coverage is still migration work, not an approved reduction. Do not cut over the production document flow on the assumption it preserves all historical coverage. Any smaller release scope requires a separate concrete product decision.

## Florida first acceptance slice

Both historical Florida driver-license entries are tracked below. The candidate preserves English OCR, explicit US month/day order, stable native crop selection, bounded deterministic profiles and manual crop retry as behaviors. It does not retain the old layout coordinates or date matcher expressions. Validate each permissioned layout sample with automatic DOB recognition, forced automatic failure followed by manual crop recovery, just-under/at-age boundary dates, no-selfie/no-portrait-match operation, cancellation and cleanup. Desktop/mobile camera tests and screen-light behavior are integration requirements. **No Florida real-document result has been established yet.**

## Verification performed

`node --test tests/verification-document.test.mjs` exercises date-label association, issue/expiry rejection, conflicting dates, ambiguous printed order/two-digit-year rejection, English/French month names, invalid/future dates, birthday and leap-day boundaries, clipped native crop mapping, result minimization, two-attempt bounds and focused rereading, stable crop selection, termination, late-result handling, timeout and cancellation. MRZ checks cover all three formats, each required checksum, long document numbers, complete-row enforcement, bounded numeric OCR correction, competing records, century/underage behavior and full-image integration. Reader-facing unit tests replace `ocr.ts` with a controlled adapter and synthetic text; they do not establish actual recognition accuracy.

**Indra OCR port check (October 19, 2026):** on nine synthetic images (clean, noisy/JPEG, small and large ID-style cards; a TD3 MRZ in Courier New; a light-on-dark French line; single lines at 12, 48 and 160 px), the browser port's text matched the Python `indra-ocr` 1.1.1 package run with the same detection rule exactly. `readDocument` returned the DOB for the four cards (label location then focused reread), the MRZ and two selected regions. Cards tilted 2–15° were read correctly after levelling; without levelling, reading degraded from about 4°. In the hidden browser pane, model loading took about 1.4 s and each read about 1 s including about 0.35 s of levelling. These are synthetic checks, not accuracy on real documents.

**First real-document phone test (October 19, 2026, owner's own Florida license, image not retained in the repository):** automatic reading failed because the small `3 DOB` field label shares a line with the much larger date digits and was read as `2.00s` / `2 00` / `oon`; the printed date itself was read correctly. The labelled-DOB rule therefore (correctly) refused it and opened manual selection. Every manual box also failed until the replicated-border change above; after it, tight and full-line boxes around the date returned the DOB, and a box that also contained the expiry date was still rejected. Automatic reading of this layout remains unsolved without a policy decision on unlabelled dates.

**Prior MRZ browser acceptance remains unresolved:** on September 19, 2026, Chrome ran the real retained OCR worker against the two fictional ICAO TD3 rows drawn in `tests/browser/verification-fixtures.ts` (1400×240 canvas, 42px monospace). The fixture was not clipped. The previous four-attempt implementation misread the nationality `UTO` as `UT0`, with some attempts also adding or changing a character in the optional-data field. The unchanged structural/checksum safeguards rejected the output as `DATE_UNREADABLE`. The same rows pass the pure parser tests. This isolates a concrete recognition/normalization gap rather than proving passport support; do not mark MRZ browser acceptance complete. The local fixture exposes its **synthetic-only** OCR rows for reproducing this failure; production document diagnostics still do not expose OCR text.

Indra OCR makes the same `UTO` → `UT0` confusion on this canvas fixture, and the Python package does too when the rows use Menlo/Monaco/Andale glyphs (Chrome's default monospace); it reads them correctly in Courier/Courier New. Real MRZs use OCR-B, which has not been tested. MRZ browser acceptance therefore remains outstanding.

A second browser run constrained the final existing OCR attempt to ICAO characters (`A–Z`, `0–9`, `<`). It still failed: the country-code confusion remained and some filler characters were omitted. That ineffective setting change was reverted. No checksum, length, or alphanumeric-field safeguards were relaxed to make the fixture pass.

## Historical selectable-configuration inventory (audit only)

Source: `source/frontend/js/app/avs.js/config/scanId.ts`; SHA-256 `be3d3bb0652d48420adffd7d387c153092600305fe70d06c521c1c62dc64dfd5`. Read-only TypeScript transpilation of this data object counted **37 countries**, **106 national/subdivision rows**, and **420 configured entries**: 56 ID-card, 200 passport, and 164 driver-license entries. National passport rules repeated across subdivisions are counted in each selectable row; these are not 420 distinct validated document designs. Zero means the historical array was empty. No coordinates, date expressions or underlying layout rules are reproduced here.

Every row's new-engine validation status is **outstanding**.

| Country | Region | ID card entries | Passport entries | Driver-license entries |
|---|---|---:|---:|---:|
| Australia (AU) | Australian Capital Territory (ACT) | 0 | 2 | 1 |
| Australia (AU) | New South Wales (NSW) | 0 | 2 | 1 |
| Australia (AU) | Northern Territory (NT) | 0 | 2 | 2 |
| Australia (AU) | Queensland (QLD) | 0 | 2 | 2 |
| Australia (AU) | South Australia (SA) | 0 | 2 | 1 |
| Australia (AU) | Tasmania (TAS) | 0 | 2 | 1 |
| Australia (AU) | Victoria (VIC) | 0 | 2 | 1 |
| Australia (AU) | Western Australia (WA) | 0 | 2 | 1 |
| Austria (AT) | National (—) | 2 | 2 | 2 |
| Belgium (BE) | National (—) | 1 | 2 | 2 |
| Bulgaria (BG) | National (—) | 1 | 1 | 1 |
| Canada (CA) | Alberta (AB) | 0 | 2 | 2 |
| Canada (CA) | British Columbia (BC) | 0 | 2 | 2 |
| Canada (CA) | Manitoba (MB) | 0 | 2 | 1 |
| Canada (CA) | New Brunswick (NB) | 0 | 2 | 1 |
| Canada (CA) | Newfoundland and Labrador (NL) | 0 | 2 | 1 |
| Canada (CA) | Nova Scotia (NS) | 0 | 2 | 1 |
| Canada (CA) | Ontario (ON) | 0 | 2 | 1 |
| Canada (CA) | Prince Edward Island (PE) | 0 | 2 | 1 |
| Canada (CA) | Quebec (QC) | 0 | 2 | 1 |
| Canada (CA) | Saskatchewan (SK) | 0 | 2 | 1 |
| Canada (CA) | Northwest Territories (NT) | 0 | 2 | 2 |
| Canada (CA) | Nunavut (NU) | 0 | 2 | 1 |
| Canada (CA) | Yukon (YT) | 0 | 2 | 1 |
| China, People's Republic of (CN) | National (—) | 1 | 0 | 0 |
| Croatia (HR) | National (—) | 2 | 2 | 1 |
| Czech Republic (CZ) | National (—) | 2 | 1 | 1 |
| Denmark (DK) | National (—) | 0 | 2 | 2 |
| Estonia (EE) | National (—) | 2 | 2 | 1 |
| Finland (FI) | National (—) | 2 | 2 | 2 |
| France (FR) | National (—) | 2 | 2 | 2 |
| Germany (DE) | National (—) | 2 | 2 | 2 |
| Greece (EL) | National (—) | 2 | 1 | 2 |
| Hong Kong (HK) | National (—) | 1 | 0 | 0 |
| Hungary (HU) | National (—) | 1 | 1 | 1 |
| Iceland (IS) | National (—) | 0 | 1 | 2 |
| Ireland (IE) | National (—) | 0 | 2 | 2 |
| Italy (IT) | National (—) | 2 | 2 | 2 |
| Latvia (LV) | National (—) | 2 | 2 | 2 |
| Liechtenstein (LI) | National (—) | 2 | 1 | 1 |
| Lithuania (LT) | National (—) | 2 | 2 | 2 |
| Luxembourg (LU) | National (—) | 2 | 1 | 1 |
| Malta (MT) | National (—) | 1 | 2 | 2 |
| Netherlands (NL) | National (—) | 2 | 2 | 2 |
| Norway (NO) | National (—) | 2 | 2 | 2 |
| Poland (PL) | National (—) | 2 | 2 | 2 |
| Portugal (PT) | National (—) | 2 | 2 | 2 |
| Republic of Cyprus (CY) | National (—) | 2 | 2 | 1 |
| Romania (RO) | National (—) | 3 | 1 | 2 |
| Slovakia (SK) | National (—) | 2 | 2 | 2 |
| Slovenia (SI) | National (—) | 2 | 2 | 2 |
| Spain (ES) | National (—) | 2 | 2 | 1 |
| Sweden (SE) | National (—) | 2 | 2 | 2 |
| Switzerland (CH) | National (—) | 2 | 2 | 2 |
| United Kingdom (UK) | National (—) | 1 | 2 | 2 |
| United States (US) | Alabama (AL) | 0 | 2 | 2 |
| United States (US) | Arkansas (AR) | 0 | 2 | 2 |
| United States (US) | Louisiana (LA) | 0 | 2 | 1 |
| United States (US) | Mississippi (MS) | 0 | 2 | 1 |
| United States (US) | Montana (MT) | 0 | 2 | 1 |
| United States (US) | North Carolina (NC) | 0 | 2 | 1 |
| United States (US) | Texas (TX) | 0 | 2 | 1 |
| United States (US) | Utah (UT) | 0 | 2 | 1 |
| United States (US) | Virginia (VA) | 0 | 2 | 1 |
| United States (US) | Alaska (AK) | 0 | 2 | 2 |
| United States (US) | Arizona (AZ) | 0 | 2 | 2 |
| United States (US) | California (CA) | 0 | 2 | 1 |
| United States (US) | Colorado (CO) | 0 | 2 | 2 |
| United States (US) | Connecticut (CT) | 0 | 2 | 2 |
| United States (US) | Delaware (DE) | 0 | 2 | 1 |
| United States (US) | Florida (FL) | 0 | 2 | 2 |
| United States (US) | Georgia (GA) | 0 | 2 | 2 |
| United States (US) | Hawaii (HI) | 0 | 2 | 2 |
| United States (US) | Idaho (ID) | 0 | 2 | 2 |
| United States (US) | Illinois (IL) | 0 | 2 | 2 |
| United States (US) | Indiana (IN) | 0 | 2 | 1 |
| United States (US) | Iowa (IA) | 0 | 2 | 1 |
| United States (US) | Kansas (KS) | 0 | 2 | 2 |
| United States (US) | Kentucky (KY) | 0 | 2 | 2 |
| United States (US) | Maine (ME) | 0 | 2 | 2 |
| United States (US) | Maryland (MD) | 0 | 2 | 1 |
| United States (US) | Massachusetts (MA) | 0 | 2 | 1 |
| United States (US) | Michigan (MI) | 0 | 2 | 2 |
| United States (US) | Minnesota (MN) | 0 | 2 | 1 |
| United States (US) | Missouri (MO) | 0 | 2 | 1 |
| United States (US) | Nebraska (NE) | 0 | 2 | 2 |
| United States (US) | Nevada (NV) | 0 | 2 | 2 |
| United States (US) | New Hampshire (NH) | 0 | 2 | 1 |
| United States (US) | New Jersey (NJ) | 0 | 2 | 1 |
| United States (US) | New Mexico (NM) | 0 | 2 | 1 |
| United States (US) | New York (NY) | 0 | 2 | 2 |
| United States (US) | North Dakota (ND) | 0 | 2 | 2 |
| United States (US) | Ohio (OH) | 0 | 2 | 2 |
| United States (US) | Oklahoma (OK) | 0 | 2 | 2 |
| United States (US) | Oregon (OR) | 0 | 2 | 2 |
| United States (US) | Pennsylvania (PA) | 0 | 2 | 2 |
| United States (US) | Rhode Island (RI) | 0 | 2 | 1 |
| United States (US) | South Carolina (SC) | 0 | 2 | 2 |
| United States (US) | South Dakota (SD) | 0 | 2 | 1 |
| United States (US) | Tennessee (TN) | 0 | 2 | 2 |
| United States (US) | Vermont (VT) | 0 | 2 | 2 |
| United States (US) | Washington (WA) | 0 | 2 | 1 |
| United States (US) | Washington DC (DC) | 0 | 2 | 2 |
| United States (US) | West Virginia (WV) | 0 | 2 | 3 |
| United States (US) | Wisconsin (WI) | 0 | 2 | 3 |
| United States (US) | Wyoming (WY) | 0 | 2 | 2 |

### DOB localization acceptance (September 19, 2026)

The actual browser worker passed a synthetic 1200×760 multi-column card containing DOB, issue and expiry fields. It located the DOB column and reread an automatically cropped region in exactly two calls. English, French and human-selected-region optical fixtures also passed after the change. Production-entry journey tests verify manual box selection after exactly two failed automatic calls, no premature outcome, and capture-quality bypass/retake/back cleanup. Locator tests cover shuffled reading order, adjacent columns, English/French labels, damaged digit shapes and ambiguous fields. These tests establish the implemented mechanics; no real-ID automatic success rate has been measured.

### ID field follow-up

The locator supports numbered fields such as `3 DOB`, `3DOB` and exact colon-joined `DOB:date` OCR words while preserving ISS/EXP exclusion. A sole DOB label with nearby unreadable value text can nominate a bounded provisional crop; it cannot infer the date. A second full-image reading that newly resolves the DOB can use complete words and their physical rows inside the located region without a third OCR call. Original-date contradictions still fail closed. Unit tests cover these cases. The later manual-selection correction accepts a bare date only within an explicitly selected crop and rejects multiple dates and recognized invoice/issue/expiry fields.

Document ID remains a development prototype for date extraction. Genuine-document validation is not implemented. The browser-asserted result also does not protect against deliberate client tampering. Production document authenticity and trusted-result verification are separate outstanding capabilities.

### Selection catalog audit and manual recovery correction

The 37 selectable countries and three document types configure capture guidance/defaults, not validated issuer-layout coverage. Only English/French OCR languages, DOB-label grammar and written month names are implemented. A numbered field without recognized DOB text does not identify the birth-date field automatically. Florida defaults do not encode a Florida-specific DOB coordinate. MRZ parsing is separate and its optical acceptance remains unresolved.

A mandatory recognized label in manual crops blocked recovery on small or unfamiliar labels. Manual recovery therefore now reads one date from deliberately selected pixels, with no label prerequisite. Automatic OCR remains conservative (recognized field context or valid MRZ), and still stops after at most two calls. Manual box selection begins without a presumed detected region; the visitor must draw a box or adjust a slider before reading. The wide default box is not presented as a detected DOB. No user identity values or screenshot pixels were copied into fixtures; tests use synthetic dates.
