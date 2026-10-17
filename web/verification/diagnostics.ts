// Local, bounded diagnostics contain stages/counts only, never verification inputs.
const stages = new Set(['loading-reader', 'loading-language', 'initializing-reader', 'preparing-image', 'configuring-reader', 'recognizing', 'date-check', 'document-result']);
const statuses = new Set(['start', 'progress', 'retry', 'success', 'failure', 'cancelled']);
const codes = new Set(['INVALID_IMAGE', 'OCR_UNAVAILABLE', 'OCR_FAILED', 'TIMEOUT', 'DATE_UNREADABLE']);
const entries: Array<Record<string, string | number>> = [];
export function clearDiagnostics() { entries.length = 0; }
export function recordDiagnostic(stage: string, status: string, details: Record<string, unknown> = {}) {
  if (!stages.has(stage) || !statuses.has(status)) return;
  const entry: Record<string, string | number> = { stage, status };
  for (const key of ['attempt', 'durationMs', 'progress']) {
    const value = details[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= (key === 'progress' ? 1 : 1000000)) entry[key] = value;
  }
  if (typeof details.code === 'string' && codes.has(details.code)) entry.code = details.code;
  entries.push(entry);
  if (entries.length > 256) entries.shift();
}
export function diagnosticReport() { return entries.map(entry => JSON.stringify(entry)).join('\n'); }
