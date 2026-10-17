import type { NormalizedCrop } from './crop';
import { parseBirthDate, type DateOrder } from './dates';

export type OCRWord = { text: string; confidence?: number; bbox: { x0: number; y0: number; x1: number; y1: number } };
type Box = OCRWord['bbox'];
type Span = { text: string; box: Box; ids: number[] };
type Label = Span & { birth: boolean; inlineDate?: boolean };

const birthLabel = /^(?:d\s*o\s*b|date of birth|birth\s*date|date de naissance|nee? le)$/;
const competingLabel = /^(?:date (?:of )?(?:issue|expiry|expiration)|issue[ds]?|issuance|expires?|expiry|expiration|exp|iss|delivre|delivrance|valid(?:ity)?|valable|address|adresse|name|nom)$/;
const normalize = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[.:]/g, '').replace(/\s+/g, ' ').trim();
// Field numbers are part of the label region, including when OCR joins `3DOB`.
// Strip them only before matching an entire known label, never a substring.
const normalizeLabel = (text: string) => normalize(text).replace(/^(?:4[ab]|\d{1,2})\s*(?=[a-z])/, '');
const height = (box: Box) => box.y1 - box.y0;
const union = (a: Box, b: Box): Box => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });
const overlap = (a: Box, b: Box) => Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
const intersects = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/** A spatial relationship, never a declaration that this is a valid birth date. */
function distance(label: Box, date: Box): number | null {
  const h = Math.max(height(label), height(date));
  const sameLine = overlap(label, date) >= Math.min(height(label), height(date)) * .45;
  const rightGap = date.x0 - label.x1;
  if (sameLine && rightGap >= -h * .2 && rightGap <= h * 12) return Math.max(0, rightGap) / h;
  const belowGap = date.y0 - label.y1;
  const aligned = date.x0 >= label.x0 - h && date.x0 <= label.x1 + h;
  if (aligned && belowGap >= -h * .15 && belowGap <= h * 2.5) return 1 + Math.max(0, belowGap) / h + Math.abs(date.x0 - label.x0) / (h * 4);
  return null;
}

/** Find a DOB label and an adjacent date using geometry, independent of OCR reading order.
 * The caller must reread the returned region with strict DOB parsing; this does not validate a date.
 * Missing, conflicting, or ambiguous fields fail closed to manual selection.
 */
export function locateBirthDateRegion(words: OCRWord[], width: number, imageHeight: number, dateOrder?: DateOrder): { crop: NormalizedCrop; provisional?: true } | null {
  if (!Array.isArray(words) || words.length > 1500 || ![width, imageHeight].every(n => Number.isSafeInteger(n) && n > 0) || (dateOrder && !['MDY', 'DMY', 'YMD'].includes(dateOrder))) return null;
  const items: Span[] = [];
  for (const [id, word] of words.entries()) {
    if (!word || typeof word.text !== 'string' || word.text.length > 120 || !word.text.trim()) continue;
    const box = word.bbox;
    if (!box || ![box.x0, box.y0, box.x1, box.y1].every(Number.isFinite) || box.x0 < 0 || box.y0 < 0 || box.x1 > width || box.y1 > imageHeight || box.x1 <= box.x0 || box.y1 <= box.y0) return null;
    items.push({ text: word.text.trim(), box, ids: [id] });
  }
  // Form physical rows first. OCR's flat text often interleaves unrelated columns.
  const rows: Span[][] = [];
  for (const item of items.sort((a, b) => a.box.y0 - b.box.y0 || a.box.x0 - b.box.x0)) {
    const row = rows.find(row => overlap(row[0].box, item.box) >= Math.min(height(row[0].box), height(item.box)) * .6);
    if (row) row.push(item); else rows.push([item]);
  }
  const labels: Label[] = [];
  const dates: Span[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.box.x0 - b.box.x0);
    for (let start = 0; start < row.length; start++) {
      let span = row[start];
      for (let end = start; end < Math.min(row.length, start + 7); end++) {
        if (end > start) {
          const next = row[end];
          if (next.box.x0 - row[end - 1].box.x1 > Math.max(height(next.box), height(row[end - 1].box)) * 2.5) break;
          span = { text: `${span.text} ${next.text}`, box: union(span.box, next.box), ids: [...span.ids, ...next.ids] };
        }
        const normalized = normalizeLabel(span.text);
        if (birthLabel.test(normalized)) labels.push({ ...span, birth: true });
        else if (competingLabel.test(normalized)) labels.push({ ...span, birth: false });
        // OCR can join a label and date into one word. Keep its complete bounds:
        // guessing character-level coordinates would crop away useful label context.
        const joined = span.ids.length === 1 ? span.text.match(/^([^:]+):\s*(\S.*)$/) : null;
        const joinedLabel = joined ? normalizeLabel(joined[1]) : '';
        const joinedBirth = birthLabel.test(joinedLabel);
        const joinedCompeting = competingLabel.test(joinedLabel);
        const dateText = joined && (joinedBirth || joinedCompeting) ? joined[2] : span.text;
        // Damaged digit glyphs can still locate a field for a higher-resolution reread.
        // They are never corrected or accepted as the resulting date here.
        const numericShape = /^[\dOIl]{1,4}\s*[/.-]\s*[\dOIl]{1,2}\s*[/.-]\s*[\dOIl]{1,4}$/i.test(dateText);
        const completeDateShape = /^(?:\d{1,4}[\s/.-]+\d{1,2}[\s/.-]+\d{1,4}|\d{1,2}[\s/.-]+[a-zÀ-ÿ]+\.?[\s,/-]+\d{4}|[a-zÀ-ÿ]+\.?[\s/.-]+\d{1,2}(?:st|nd|rd|th)?[\s,/-]+\d{4})$/i.test(dateText);
        if (numericShape || (completeDateShape && parseBirthDate(dateText, { selectedRegion: true, dateOrder }))) {
          dates.push(span);
          if (joined && (joinedBirth || joinedCompeting)) labels.push({ ...span, birth: joinedBirth, inlineDate: true });
        }
      }
    }
  }
  // Keep the complete label/date span when a shorter candidate is contained in it.
  const maximal = <T extends Span>(spans: T[]) => spans.filter(span => !spans.some(other => other !== span && other.ids.length > span.ids.length && span.ids.every(id => other.ids.includes(id))));
  const allLabels = maximal(labels);
  const birthLabels = allLabels.filter(label => label.birth);
  if (birthLabels.length !== 1) return null;
  const label = birthLabels[0];
  const nearbyDates = maximal(dates).filter(date => (label.inlineDate && date.ids.some(id => label.ids.includes(id))) || distance(label.box, date.box) !== null);
  const candidates = nearbyDates.filter(date => {
    const shared = date.ids.some(id => label.ids.includes(id));
    if (shared && !label.inlineDate) return false;
    const score = shared ? 0 : distance(label.box, date.box);
    if (score === null) return false;
    return !allLabels.some(other => !other.birth && (() => {
      const competing = other.ids.some(id => date.ids.includes(id)) ? 0 : distance(other.box, date.box);
      return competing !== null && competing <= score + .5;
    })());
  });
  if (!nearbyDates.length) {
    // A first OCR pass may read the field label but not the date's small digits.
    // Propose bounded right/below space for a strict reread; no date is inferred.
    const h = height(label.box);
    const padding = h * .4;
    const region = { x0: Math.max(0, label.box.x0 - padding), y0: Math.max(0, label.box.y0 - padding), x1: Math.min(width, label.box.x1 + h * 12), y1: Math.min(imageHeight, label.box.y1 + h * 3.5) };
    for (const other of allLabels.filter(other => !other.birth)) {
      if (!intersects(other.box, region)) continue;
      // Cut before a neighboring field, keeping both its label and value out.
      if (other.box.y0 >= label.box.y1 + padding) region.y1 = Math.min(region.y1, other.box.y0 - padding);
      else if (other.box.x0 >= label.box.x1 + padding) region.x1 = Math.min(region.x1, other.box.x0 - padding);
      else return null;
    }
    if (region.x1 <= label.box.x1 || region.y1 <= label.box.y1) return null;
    if (allLabels.some(other => !other.birth && intersects(other.box, region))) return null;
    // Known dates outside the eligible geometry must not sneak into a wider crop.
    if (maximal(dates).some(date => intersects(date.box, region))) return null;
    // Require visible undecoded value text; do not spend the reread on blank space.
    const labelIds = new Set(allLabels.flatMap(other => other.ids));
    const hasUnreadValue = items.some(item => !labelIds.has(item.ids[0]) && /[a-z0-9?]/i.test(item.text) && item.box.x0 >= region.x0 && item.box.x1 <= region.x1 && item.box.y0 >= region.y0 && item.box.y1 <= region.y1);
    if (!hasUnreadValue) return null;
    return { crop: { x: region.x0 / width, y: region.y0 / imageHeight, width: (region.x1 - region.x0) / width, height: (region.y1 - region.y0) / imageHeight }, provisional: true };
  }
  if (candidates.length !== 1) return null;
  const date = candidates[0];
  const box = union(label.box, date.box);
  const padding = Math.max(height(label.box), height(date.box)) * .4;
  const padded = { x0: Math.max(0, box.x0 - padding), y0: Math.max(0, box.y0 - padding), x1: Math.min(width, box.x1 + padding), y1: Math.min(imageHeight, box.y1 + padding) };
  // Never crop away a competing field's label while leaving its value in the region.
  if (allLabels.some(other => !other.birth && intersects(other.box, padded))) return null;
  if (maximal(dates).some(other => other !== date && intersects(other.box, padded))) return null;
  const selectedIds = new Set([...label.ids, ...date.ids]);
  if (items.some(item => !selectedIds.has(item.ids[0]) && !/^[:.\-]+$/.test(item.text) && intersects(item.box, padded))) return null;
  return { crop: { x: padded.x0 / width, y: padded.y0 / imageHeight, width: (padded.x1 - padded.x0) / width, height: (padded.y1 - padded.y0) / imageHeight } };
}
