import { element } from './ui';

export type Selection = { x: number; y: number; width: number; height: number };

/** Percent-based pixel selection; no text or date input is accepted. */
export function cropReview(image: HTMLCanvasElement, onChange: (crop: Selection, edited: boolean) => void) {
  // A hidden starting position supports keyboard adjustment without implying
  // that this unexamined region was detected as a birth-date field.
  let crop: Selection = { x: 0.35, y: 0.4, width: 0.3, height: 0.1 };
  let edited = false;
  const container = element('div');
  const preview = element('div', undefined, 'crop-preview');
  const overlay = element('div', undefined, 'crop-selection');
  overlay.setAttribute('aria-hidden', 'true');
  preview.append(image, overlay);
  const controls = element('div', undefined, 'crop-controls');
  const inputs = new Map<keyof Selection, HTMLInputElement>();
  const labels = { x: 'Left edge', y: 'Top edge', width: 'Selection width', height: 'Selection height' };
  const update = () => {
    crop.width = Math.min(crop.width, 1 - crop.x);
    crop.height = Math.min(crop.height, 1 - crop.y);
    overlay.hidden = !edited;
    overlay.style.left = `${crop.x * 100}%`;
    overlay.style.top = `${crop.y * 100}%`;
    overlay.style.width = `${crop.width * 100}%`;
    overlay.style.height = `${crop.height * 100}%`;
    for (const [key, input] of inputs) { input.value = String(Math.round(crop[key] * 100)); input.setAttribute('aria-valuetext', `${input.value} percent`); }
    onChange({ ...crop }, edited);
  };
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    const label = element('label', labels[key]);
    const input = element('input');
    input.type = 'range'; input.min = key === 'x' || key === 'y' ? '0' : '1'; input.max = key === 'x' || key === 'y' ? '99' : '100'; input.step = '1';
    input.addEventListener('input', () => { crop[key] = Number(input.value) / 100; edited = true; update(); });
    inputs.set(key, input);
    label.append(input);
    controls.append(label);
  }
  let start: {x:number;y:number;pointerId:number} | null = null;
  const coordinate = (event: PointerEvent) => {
    const box = preview.getBoundingClientRect();
    return { x: Math.max(0, Math.min(0.99, (event.clientX - box.left) / box.width)), y: Math.max(0, Math.min(0.99, (event.clientY - box.top) / box.height)) };
  };
  preview.addEventListener('pointerdown', (event) => {
    if (start || event.button !== 0) return;
    start = { ...coordinate(event), pointerId: event.pointerId }; preview.setPointerCapture(event.pointerId); event.preventDefault();
  });
  preview.addEventListener('pointermove', (event) => {
    if (!start || event.pointerId !== start.pointerId) return;
    const end = coordinate(event);
    if (Math.abs(end.x - start.x) < 0.01 || Math.abs(end.y - start.y) < 0.01) return;
    crop = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.max(0.01, Math.abs(end.x - start.x)), height: Math.max(0.01, Math.abs(end.y - start.y)) };
    edited = true;
    update();
  });
  const endDrag = (event: PointerEvent) => { if (event.pointerId === start?.pointerId) start = null; };
  preview.addEventListener('pointerup', endDrag);
  preview.addEventListener('pointercancel', endDrag);
  preview.addEventListener('lostpointercapture', endDrag);
  container.append(preview, controls);
  update();
  return container;
}
