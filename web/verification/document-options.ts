import type { DateOrder } from './dates';

export type DocumentKind = 'driver-license' | 'passport' | 'identity-card';
export type DocumentSelection = { country: string; region?: string; kind: DocumentKind };
type Place = { code: string; label: string };
export type DocumentProfile = {
  language: 'eng' | 'fra'; dateOrder?: DateOrder;
  captureTitle: string; captureInstruction: string; readerHint: string;
};

// Geographic facts, authored separately from the retired document-layout engine.
// References and scope are recorded in docs/DOCUMENT_SELECTION.md.
const countryNames = new Intl.DisplayNames(['en'], { type: 'region' });
export const documentCountries: readonly Place[] = [
  'AU', 'AT', 'BE', 'BG', 'CA', 'CN', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI',
  'FR', 'DE', 'GR', 'HK', 'HU', 'IS', 'IE', 'IT', 'LV', 'LI', 'LT', 'LU',
  'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'CH', 'GB', 'US',
].map(code => ({ code, label: countryNames.of(code) || code })).sort((a, b) => a.label.localeCompare(b.label));

export const documentKinds: readonly { value: DocumentKind; label: string }[] = [
  { value: 'driver-license', label: 'Driver’s license' },
  { value: 'passport', label: 'Passport' },
  { value: 'identity-card', label: 'Government ID card' },
];

const places = (rows: string): readonly Place[] => rows.split('\n').map(row => {
  const [code, ...name] = row.split(' ');
  return { code, label: name.join(' ') };
}).sort((a, b) => a.label.localeCompare(b.label));

const regions: Readonly<Record<string, readonly Place[]>> = {
  US: places(`AL Alabama
AK Alaska
AZ Arizona
AR Arkansas
CA California
CO Colorado
CT Connecticut
DE Delaware
DC District of Columbia
FL Florida
GA Georgia
HI Hawaii
ID Idaho
IL Illinois
IN Indiana
IA Iowa
KS Kansas
KY Kentucky
LA Louisiana
ME Maine
MD Maryland
MA Massachusetts
MI Michigan
MN Minnesota
MS Mississippi
MO Missouri
MT Montana
NE Nebraska
NV Nevada
NH New Hampshire
NJ New Jersey
NM New Mexico
NY New York
NC North Carolina
ND North Dakota
OH Ohio
OK Oklahoma
OR Oregon
PA Pennsylvania
RI Rhode Island
SC South Carolina
SD South Dakota
TN Tennessee
TX Texas
UT Utah
VT Vermont
VA Virginia
WA Washington
WV West Virginia
WI Wisconsin
WY Wyoming`),
  CA: places(`AB Alberta
BC British Columbia
MB Manitoba
NB New Brunswick
NL Newfoundland and Labrador
NT Northwest Territories
NS Nova Scotia
NU Nunavut
ON Ontario
PE Prince Edward Island
QC Quebec
SK Saskatchewan
YT Yukon`),
  AU: places(`ACT Australian Capital Territory
NSW New South Wales
NT Northern Territory
QLD Queensland
SA South Australia
TAS Tasmania
VIC Victoria
WA Western Australia`),
};

export const documentRegions = (country: string): readonly Place[] => regions[country] ?? [];
export const requiresDocumentRegion = (selection: DocumentSelection): boolean =>
  selection.kind !== 'passport' && documentRegions(selection.country).length > 0;

/** Selection guides capture and OCR defaults; it is not proof of issuer authenticity. */
export function documentProfile(selection: DocumentSelection): DocumentProfile | null {
  const country = documentCountries.find(item => item.code === selection.country);
  const kind = documentKinds.find(item => item.value === selection.kind);
  if (!country || !kind) return null;
  const needsRegion = requiresDocumentRegion(selection);
  const region = needsRegion ? documentRegions(selection.country).find(item => item.code === selection.region) : undefined;
  if (needsRegion && !region) return null;
  const language = selection.country === 'FR' || (selection.country === 'CA' && region?.code === 'QC') ? 'fra' : 'eng';
  const issuer = [region?.label, country.label].filter(Boolean).join(', ');
  if (selection.kind === 'passport') return {
    language,
    captureTitle: 'Scan your passport',
    captureInstruction: `Open your ${country.label} passport to the photo and personal-details page. Include the printed date of birth and both machine-readable lines at the bottom, without glare.`,
    readerHint: 'Keep the full personal-details page in view. No live selfie is needed for this document check.',
  };
  return {
    language,
    // Settles day/month order only when both readings are real dates; any common format is read.
    dateOrder: selection.country === 'US' ? 'MDY' : undefined,
    captureTitle: selection.kind === 'driver-license' ? 'Scan your driver’s license' : 'Scan your government ID card',
    captureInstruction: `Show the side of your ${issuer} ${selection.kind === 'driver-license' ? 'driver’s license' : 'ID card'} that contains the printed date of birth. Keep the date and its label sharp, with the whole card in view.`,
    readerHint: 'Keep the printed date of birth sharp and free of glare. No live selfie is needed for this document check.',
  };
}
