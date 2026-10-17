# Document selection and reading settings

The independent UI restores country, state/province/territory and document-type selection. `web/verification/document-options.ts` covers the 37-country product scope recorded in the migration inventory, using current `GB` and `GR` country identifiers. Labels come from the browser's `Intl.DisplayNames`. Driver's licenses, passports and government ID cards are available as separate capture paths.

US licenses and ID cards require a state (50 states plus District of Columbia); Canadian cards require one of 13 provinces/territories; Australian cards require one of eight states/territories. Passports use a national issuer and do not require a state. Changing country or document type must not carry an invalid previous subdivision into the new selection.

These geographic names and codes are factual UI data authored independently of Go.Cam. References:

- [USPS state abbreviations](https://pe.usps.com/text/pub28/28apb.htm)
- [Statistics Canada province and territory codes](https://www.statcan.gc.ca/en/subjects/standard/sgc/2021/introduction)
- [Australian Government state and territory names](https://www.stylemanual.gov.au/grammar-punctuation-and-conventions/names-and-terms/australian-place-names)

Selections have concrete effects: required subdivision validation, English/French starting language (including Quebec), editable US-card month/day/year starting order, and capture guidance for card DOB versus passport personal-details/MRZ page. Other numeric date orders must be explicitly chosen. There is no inferred universal country-to-date-format table: the visitor must check the order printed on the document. A selected region supplies pixels only and never accepts a typed birth date.

The catalogue contains no copied OCR coordinates, regular expressions, layouts, images or document templates. It does not prove all issuer layouts are readable. Recognition still uses the independent generic DOB/MRZ reader and its documented accuracy/coverage limits in `DOCUMENT_COVERAGE.md`.

Per the owner's corrected product requirement, a document check reads the document birth date and applies the site's required age. It does not request a selfie, compare a portrait, or authenticate an identity. Country, subdivision and document selection stay in browser memory and are not sent as part of the result.
