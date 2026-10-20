import { cropToPixels, type NormalizedCrop } from './crop';
import { recordDiagnostic } from './diagnostics';
import { hasConflictingBirthDates, parseBirthDate, parseUnlabelledBirthDate, printedDates, type BirthDate, type DateOrder } from './dates';
import { inspectMRZ } from './mrz';
import { locateBirthDateRegion, type OCRWord } from './document-locator';
import { createOCRReader, straighten, type OCRReader, type OCRResult } from './ocr';

export type DocumentReadCode = 'INVALID_IMAGE' | 'OCR_UNAVAILABLE' | 'OCR_FAILED' | 'TIMEOUT' | 'DATE_UNREADABLE';
export class DocumentReadError extends Error {
  constructor(public readonly code: DocumentReadCode) {
    const messages: Record<DocumentReadCode, string> = {
      INVALID_IMAGE: 'Choose a usable image region.', OCR_UNAVAILABLE: 'The document reader is unavailable.',
      OCR_FAILED: 'The document reader could not finish. Please try again.', TIMEOUT: 'The document reader took too long. Please try again.',
      DATE_UNREADABLE: 'Select the birth date on your document and try again.',
    };
    super(messages[code]);
    this.name = 'DocumentReadError';
  }
}

// Release text and nested layout references, including late results after cancellation.
function clearOCR(result: OCRResult) {
  if (!result?.data) return;
  for (const key of Object.keys(result.data)) delete result.data[key];
  result.data.text = '';
}
type ReadOptions = {
  image: HTMLCanvasElement;
  crop?: NormalizedCrop;
  language?: 'eng' | 'fra';
  dateOrder?: DateOrder;
  signal?: AbortSignal;
  onProgress?: (stage: string, progress?: number) => void;
};

export const OCR_TIMEOUT_MS = 90_000;
// Two recognize calls total per read, including the focused retry.
export const OCR_MAX_ATTEMPTS = 2;
const profiles = [
  { scale: 1, grayscale: false, contrast: 1 },
  { scale: 2, grayscale: true, contrast: 1.25 },
] as const;

function preparedImage(source: HTMLCanvasElement, crop: NormalizedCrop, profile: typeof profiles[number]): HTMLCanvasElement {
  const pixels = cropToPixels(crop, source.width, source.height);
  const canvas = document.createElement('canvas');
  const scale = Math.min(profile.scale, 4096 / Math.max(pixels.width, pixels.height), Math.sqrt(8_000_000 / (pixels.width * pixels.height)));
  canvas.width = Math.max(1, Math.round(pixels.width * scale));
  canvas.height = Math.max(1, Math.round(pixels.height * scale));
  try {
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new DocumentReadError('INVALID_IMAGE');
    context.drawImage(source, pixels.x, pixels.y, pixels.width, pixels.height, 0, 0, canvas.width, canvas.height);
    if (profile.grayscale) {
      const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;
      for (let index = 0; index < data.length; index += 4) {
        const gray = .2126 * data[index] + .7152 * data[index + 1] + .0722 * data[index + 2];
        const adjusted = Math.min(255, Math.max(0, (gray - 128) * profile.contrast + 128));
        data[index] = data[index + 1] = data[index + 2] = adjusted;
      }
      context.putImageData(imageData, 0, 0);
      data.fill(0);
    }
    return canvas;
  } catch {
    canvas.width = canvas.height = 0;
    throw new DocumentReadError('INVALID_IMAGE');
  }
}
const sameDate = (a: BirthDate, b: BirthDate) => a.year === b.year && a.month === b.month && a.day === b.day;

/** Rebuild only complete words inside a located region, preserving physical rows.
 * This consumes already recognized pixels; it never schedules another OCR call.
 */
function readLocatedDate(words: OCRWord[], crop: NormalizedCrop, width: number, height: number, dateOrder?: DateOrder): BirthDate | null {
  const bounds = cropToPixels(crop, width, height);
  const selected = words.filter(word => {
    const b = word?.bbox;
    return b && typeof word.text === 'string' && word.text.length <= 120 &&
      [b.x0, b.x1, b.y0, b.y1].every(Number.isFinite) && b.x1 > b.x0 && b.y1 > b.y0 &&
      b.x0 >= bounds.x && b.y0 >= bounds.y && b.x1 <= bounds.x + bounds.width && b.y1 <= bounds.y + bounds.height;
  }).sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
  const rows: OCRWord[][] = [];
  for (const word of selected) {
    const box = word.bbox;
    const row = rows.find(row => {
      const first = row[0].bbox;
      return Math.min(first.y1, box.y1) - Math.max(first.y0, box.y0) >= Math.min(first.y1 - first.y0, box.y1 - box.y0) * .45;
    });
    if (row) row.push(word); else rows.push([word]);
  }
  const text = rows.map(row => row.sort((a, b) => a.bbox.x0 - b.bbox.x0).map(word => word.text).join(' ')).join('\n');
  return parseBirthDate(text, { dateOrder });
}

/** All image/text processing stays in browser memory. Only fixed progress labels leave this module. */
export async function readDocument(options: ReadOptions): Promise<{ birthDate: BirthDate; source: 'label' | 'earliest-date' | 'selected-region' | 'mrz' }> {
  const { image, signal, onProgress, dateOrder } = options;
  if (signal?.aborted) throw new DOMException('Verification cancelled.', 'AbortError');
  if (!image || !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width <= 0 || image.height <= 0) throw new DocumentReadError('INVALID_IMAGE');
  const crop = options.crop ?? { x: 0, y: 0, width: 1, height: 1 };
  try { cropToPixels(crop, image.width, image.height); } catch { throw new DocumentReadError('INVALID_IMAGE'); }
  // One Latin-script recognizer reads both supported document languages.
  const language = options.language ?? 'eng';
  if (!['eng', 'fra'].includes(language) || (dateOrder && !['MDY', 'DMY', 'YMD'].includes(dateOrder))) throw new DocumentReadError('OCR_FAILED');
  let reader: OCRReader;
  try { reader = createOCRReader(); } catch { throw new DocumentReadError('OCR_UNAVAILABLE'); }
  let closed = false;
  let stop!: (reason: unknown) => void;
  const stopped = new Promise<never>((_, reject) => { stop = reject; });
  void stopped.catch(() => {});
  const abort = () => stop(new DOMException('Verification cancelled.', 'AbortError'));
  const timer = setTimeout(() => stop(new DocumentReadError('TIMEOUT')), OCR_TIMEOUT_MS);
  signal?.addEventListener('abort', abort, { once: true });
  const report = (stage: string, progress?: number) => {
    if (!closed && !signal?.aborted) {
      recordDiagnostic(stage, progress === undefined ? 'start' : 'progress', { progress });
      onProgress?.(stage, progress);
    }
  };
  const run = async <T>(stage: string, operation: () => Promise<T>): Promise<T> => {
    if (signal?.aborted) throw new DOMException('Verification cancelled.', 'AbortError');
    report(stage);
    return Promise.race([operation(), stopped]);
  };
  // A full image is levelled once, so located fields are cropped from the frame their
  // word boxes describe. A selected region is levelled on its own.
  let level: HTMLCanvasElement | null | undefined;
  try {
    await run('loading-reader', () => reader.load());
    let focusedCrop: NormalizedCrop | undefined;
    let previousBirthDate: BirthDate | null = null;
    let sawInvalidMRZ = false;
    let firstUnlabelled: BirthDate | null = null;
    let firstPassDates: BirthDate[] = [];
    for (let index = 0; index < OCR_MAX_ATTEMPTS; index++) {
      recordDiagnostic('preparing-image', 'start', { attempt: index + 1 });
      if (signal?.aborted) throw new DOMException('Verification cancelled.', 'AbortError');
      report('preparing-image', index / OCR_MAX_ATTEMPTS);
      const profile = profiles[index];
      if (!options.crop && level === undefined) level = straighten(image);
      let prepared = preparedImage(level ?? image, focusedCrop ?? crop, profile);
      if (options.crop) {
        const levelled = straighten(prepared);
        if (levelled) { prepared.width = prepared.height = 0; prepared = levelled; }
      }
      let result: OCRResult | undefined;
      try {
        result = await run('recognizing', () => reader.recognize(prepared, progress => {
          if (Number.isFinite(progress)) report('recognizing', Math.max(0, Math.min(1, progress)));
        }).then(value => {
          if (closed || signal?.aborted) clearOCR(value);
          return value;
        }));
        if (signal?.aborted) throw new DOMException('Verification cancelled.', 'AbortError');
        const text = typeof result?.data?.text === 'string' ? result.data.text : '';
        const birthDate = parseBirthDate(text, { dateOrder, selectedRegion: Boolean(options.crop) });
        const mrz = options.crop || focusedCrop ? { status: 'absent' as const } : inspectMRZ(text);
        if (mrz.status === 'conflict' || hasConflictingBirthDates(text, { dateOrder })) throw new DocumentReadError('DATE_UNREADABLE');
        if (mrz.status === 'invalid') { sawInvalidMRZ = true; continue; }
        if (mrz.status === 'valid') {
          if (birthDate && !sameDate(birthDate, mrz.birthDate)) throw new DocumentReadError('DATE_UNREADABLE');
          recordDiagnostic('document-result', 'success');
          return { birthDate: mrz.birthDate, source: 'mrz' };
        }
        // A vanished MRZ must not bypass a failed checksum on a previous pass.
        if (sawInvalidMRZ) continue;
        const words = result?.data?.words;
        const hasLayout = Array.isArray(words) && words.length > 0;
        const located = !options.crop && hasLayout
          ? locateBirthDateRegion(words, prepared.width, prepared.height, dateOrder) : null;
        if (index === 0 && located) {
          // Normalized coordinates map directly back to the (levelled) full-image pixels.
          focusedCrop = located.crop;
          previousBirthDate = birthDate;
          recordDiagnostic('date-check', 'retry', { attempt: index + 1 });
          continue;
        }
        // A clearer second full-image pass can resolve the field without a third OCR call.
        const spatialDate = index === 1 && located
          ? readLocatedDate(words!, located.crop, prepared.width, prepared.height, dateOrder) : null;
        if (spatialDate) {
          if ((birthDate && !sameDate(birthDate, spatialDate)) || (previousBirthDate && !sameDate(previousBirthDate, spatialDate))) throw new DocumentReadError('DATE_UNREADABLE');
          recordDiagnostic('document-result', 'success');
          return { birthDate: spatialDate, source: 'label' };
        }
        if (birthDate && (options.crop || focusedCrop || !hasLayout)) {
          if (previousBirthDate && !sameDate(previousBirthDate, birthDate)) throw new DocumentReadError('DATE_UNREADABLE');
          recordDiagnostic('document-result', 'success');
          return { birthDate, source: options.crop ? 'selected-region' : 'label' };
        }
        // No DOB label could be read anywhere: fall back to the earliest printed date. One
        // pass may choose it, but the other pass must have read that same date too, and two
        // different choices fail closed.
        if (!options.crop && !focusedCrop && !located && !birthDate) {
          const unlabelled = parseUnlabelledBirthDate(text, { dateOrder });
          if (index === 0) {
            firstUnlabelled = previousBirthDate = unlabelled;
            firstPassDates = printedDates(text, { dateOrder });
          } else {
            const chosen = firstUnlabelled && unlabelled && !sameDate(firstUnlabelled, unlabelled) ? null : firstUnlabelled ?? unlabelled;
            const confirmedBy = firstUnlabelled ? printedDates(text, { dateOrder }) : firstPassDates;
            if (chosen && confirmedBy.some(date => sameDate(date, chosen))) {
              recordDiagnostic('document-result', 'success');
              return { birthDate: chosen, source: 'earliest-date' };
            }
          }
        }
        recordDiagnostic('date-check', 'retry', { attempt: index + 1 });
      } finally {
        if (result) clearOCR(result);
        prepared.width = prepared.height = 0;
      }
    }
    throw new DocumentReadError('DATE_UNREADABLE');
  } catch (error) {
    recordDiagnostic('document-result', signal?.aborted ? 'cancelled' : 'failure', { code: error instanceof DocumentReadError ? error.code : 'OCR_FAILED' });
    if (signal?.aborted) throw new DOMException('Verification cancelled.', 'AbortError');
    if (error instanceof DocumentReadError || (error instanceof DOMException && error.name === 'AbortError')) throw error;
    throw new DocumentReadError('OCR_FAILED');
  } finally {
    closed = true;
    if (level) level.width = level.height = 0;
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    try { reader.terminate(); } catch { /* No private cleanup diagnostics. */ }
  }
}
