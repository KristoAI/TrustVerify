# Document selection and reading settings

The independent UI restores country, state/province/territory and document-type selection. `web/verification/document-options.ts` covers the 37-country product scope recorded in the migration inventory, using current `GB` and `GR` country identifiers. Labels come from the browser's `Intl.DisplayNames`. Driver's licenses, passports and government ID cards are available as separate capture paths.

US licenses and ID cards require a state (50 states plus District of Columbia); Canadian cards require one of 13 provinces/territories; Australian cards require one of eight states/territories. Passports use a national issuer and do not require a state. Changing country or document type must not carry an invalid previous subdivision into the new selection.

These geographic names and codes are factual UI data authored independently of Go.Cam. References:

- [USPS state abbreviations](https://pe.usps.com/text/pub28/28apb.htm)
- [Statistics Canada province and territory codes](https://www.statcan.gc.ca/en/subjects/standard/sgc/2021/introduction)
- [Australian Government state and territory names](https://www.stylemanual.gov.au/grammar-punctuation-and-conventions/names-and-terms/australian-place-names)

Selections have concrete effects: required subdivision validation, English/French starting language (including Quebec), a month/day/year preference for US cards, and capture guidance for card DOB versus passport personal-details/MRZ page. Visitors are not asked for a date order (owner decision, October 19, 2026: the question confused people and led to wrong choices). The reader accepts every common printed form: `1988-08-24`, `08/24/1988`, `24.08.1988`, `19880824`, `24 AUG 1988`, `24AUG1988`, `AUG 24, 1988` and `1988 AUG 24`, with English or French month names. Day and month are told apart by the digits when only one reading is a real date. When both are, the document's known order decides (US cards are month/day/year); with no known order the **later** date is used, so an unknown format can only understate an age by under a year, never overstate it. Two-digit years are still never expanded. There is no inferred universal country-to-date-format table. A selected region supplies pixels only and never accepts a typed birth date.

The catalogue contains no copied OCR coordinates, regular expressions, layouts, images or document templates. It does not prove all issuer layouts are readable. Recognition still uses the independent generic DOB/MRZ reader and its documented accuracy/coverage limits in `DOCUMENT_COVERAGE.md`.

Per the owner's corrected product requirement, a document check reads the document birth date and applies the site's required age. It does not request a selfie, compare a portrait, or authenticate an identity. Country, subdivision and document selection stay in browser memory and are not sent as part of the result.
