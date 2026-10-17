// Free XposedOrNot transport only. The caller must reserve durable endpoint
// quotas before every call; this module deliberately does not retry requests.
const API_ORIGIN = "https://api.xposedornot.com";
const TIMEOUT_MS = 10_000;
const LOOKUP_BYTES = 128 * 1024;
const CATALOG_BYTES = 8 * 1024 * 1024;

export class EmailProviderError extends Error {
  constructor(code, retryAfterSeconds) {
    super("Email history provider is unavailable");
    this.name = "EmailProviderError";
    this.code = code;
    if (retryAfterSeconds !== undefined)
      this.retryAfterSeconds = retryAfterSeconds;
  }
}

function invalidResponse() {
  return new EmailProviderError("invalid_response");
}

async function request(path, maxBytes, fetchImpl, allowNotFound = false) {
  let response;
  try {
    response = await fetchImpl(API_ORIGIN + path, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // Never retain an underlying fetch error: it may contain the email URL.
    throw new EmailProviderError("unavailable");
  }
  if (response.status === 429) {
    const retry = response.headers.get("retry-after");
    await response.body?.cancel().catch(() => {});
    throw new EmailProviderError(
      "rate_limited",
      /^\d{1,6}$/.test(retry || "")
        ? Math.min(Number(retry), 86_400)
        : undefined,
    );
  }
  if (!response.ok && !(allowNotFound && response.status === 404)) {
    await response.body?.cancel().catch(() => {});
    throw new EmailProviderError("unavailable");
  }
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      response.headers.get("content-type") || "",
    ) ||
    Number(response.headers.get("content-length")) > maxBytes ||
    !response.body
  ) {
    await response.body?.cancel().catch(() => {});
    throw invalidResponse();
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw invalidResponse();
      chunks.push(value);
    }
    const value = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw invalidResponse();
    return { value, status: response.status };
  } catch {
    // The provider body can echo the email. Do not include it in exceptions.
    await reader.cancel().catch(() => {});
    throw invalidResponse();
  } finally {
    reader.releaseLock();
  }
}

function incidentDate(value) {
  if (typeof value !== "string") return null;
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2}))?$/.exec(
      value,
    );
  if (!parts) return null;
  const [, ys, ms, ds, hs, mins, ss, offset] = parts;
  const [year, month, day] = [ys, ms, ds].map(Number);
  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > 31)
    return null;
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day)
    return null;
  if (
    hs !== undefined &&
    (Number(hs) > 23 ||
      Number(mins) > 59 ||
      Number(ss) > 59 ||
      (offset !== "Z" &&
        (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4)) > 59)))
  )
    return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

function breachId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

export async function fetchBreachCatalog({ fetchImpl = fetch } = {}) {
  const { value } = await request("/v1/breaches", CATALOG_BYTES, fetchImpl);
  if (
    !Array.isArray(value.exposedBreaches) ||
    value.exposedBreaches.length > 20_000
  )
    throw invalidResponse();
  const catalog = [];
  const ids = new Set();
  for (const record of value.exposedBreaches) {
    if (!record || typeof record !== "object" || !breachId(record.breachID))
      throw invalidResponse();
    // Duplicated identifiers could attach the wrong historical date.
    if (ids.has(record.breachID)) throw invalidResponse();
    ids.add(record.breachID);
    if (
      record.verified !== true ||
      record.searchable !== true ||
      record.sensitive !== false ||
      record.breachType !== "DataBreach" ||
      !Array.isArray(record.exposedData) ||
      !record.exposedData.includes("Email addresses") ||
      !incidentDate(record.breachedDate)
    )
      continue;
    catalog.push({ id: record.breachID, date: record.breachedDate });
  }
  return catalog;
}

// This is evidence of an address appearing in an old incident, not evidence of
// the present holder's date of birth or continuous ownership of that address.
export function eligibleHistory(
  ids,
  catalog,
  minimumYears,
  nowDate = new Date(),
) {
  if (!Number.isInteger(minimumYears) || minimumYears < 1 || minimumYears > 100)
    throw new TypeError("Invalid minimum history years");
  const now = new Date(nowDate);
  if (!Number.isFinite(now.getTime()))
    throw new TypeError("Invalid current date");
  if (!Array.isArray(ids) || !Array.isArray(catalog)) return false;
  const matches = new Set(ids.filter(breachId));
  return catalog.some((record) => {
    if (!record || !matches.has(record.id)) return false;
    const date = incidentDate(record.date);
    if (!date || date > now) return false;
    const anniversary = new Date(date);
    // Feb 29 rolls to March 1 in a non-leap anniversary year, conservatively.
    anniversary.setUTCFullYear(date.getUTCFullYear() + minimumYears);
    return anniversary <= now;
  });
}

export async function checkEmailHistory(
  email,
  catalog,
  minimumYears,
  { fetchImpl = fetch, now = () => new Date() } = {},
) {
  // The route performs full address validation. Also guard direct worker use.
  if (
    typeof email !== "string" ||
    email.length > 254 ||
    !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)
  )
    throw new TypeError("Invalid email address");
  const { value, status } = await request(
    "/v1/check-email/" + encodeURIComponent(email),
    LOOKUP_BYTES,
    fetchImpl,
    true,
  );
  if (
    value.Error === "Not found" &&
    value.email === null &&
    (status === 200 || status === 404)
  )
    return false;
  if (
    status !== 200 ||
    value.status !== "success" ||
    !Array.isArray(value.breaches) ||
    value.breaches.length !== 1 ||
    !Array.isArray(value.breaches[0]) ||
    value.breaches[0].length > 20_000 ||
    !value.breaches[0].every(breachId)
  )
    throw invalidResponse();
  return eligibleHistory(value.breaches[0], catalog, minimumYears, now());
}
