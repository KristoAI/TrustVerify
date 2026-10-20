/**
 * Browser line OCR on onnxruntime-web: a TypeScript port of Indra OCR's line
 * detection and Latin-script recognition (datalab-to/indra v1.1.1, Apache-2.0;
 * det_post.py, rec_preproc.py and pipeline.py). Modified from upstream:
 * - only det.onnx and rec.onnx run: no orientation, script routing,
 *   language-model beam search, layout or reading-order models;
 * - deskew (`straighten`) is a separate step, so the caller can crop fields
 *   from the same straightened frame the word boxes describe;
 * - detection never upscales a small image, then rescales once toward a
 *   readable line height, so tight document crops read like full pages.
 * Images, text and tensors stay in this page's memory and are zeroed after use.
 */
import type { OCRWord } from './document-locator';

export type OCRResult = { data?: { text?: string; words?: OCRWord[]; [key: string]: unknown } };
export type OCRReader = {
  load(): Promise<void>;
  recognize(image: HTMLCanvasElement, onProgress?: (progress: number) => void): Promise<OCRResult>;
  terminate(): void;
};

type Tensor = { data: Float32Array | BigInt64Array; dims: readonly number[]; dispose?(): void };
type Session = {
  run(feeds: Record<string, Tensor>, fetches?: string[]): Promise<Record<string, Tensor>>;
  release?(): Promise<void>;
};
type Runtime = {
  env: { wasm: { wasmPaths?: string; numThreads?: number; proxy?: boolean } };
  Tensor: new (type: string, data: Float32Array | BigInt64Array, dims: number[]) => Tensor;
  InferenceSession: { create(model: Uint8Array, options: Record<string, unknown>): Promise<Session> };
};
type Gray = { data: Uint8Array; width: number; height: number };
type Box = [number, number, number, number];
type Token = { id: number; x: number };
type Line = { box: Box; text: string; conf: number; tokens: Token[] };

export const OCR_ASSETS = { runtime: '/assets/vendor/onnxruntime/', models: '/assets/models/indra/' } as const;
// Upstream constants (pipeline.py, det_post.py, rec_preproc.py).
const ADAPTIVE_MIN_H = 9, ADAPTIVE_TARGET_H = 12, ADAPTIVE_MAX_SIDE = 2048;
// Local addition: very large lines (a tight crop) are reduced toward this height.
const DETECT_MAX_H = 40, DETECT_TARGET_H = 24;
const SPLIT_GAP = 3.0, MIN_CONF = 0.5, INPUT_MULTIPLE = 32, OUT_STRIDE = 2, CORE_X_SHRINK = 0.15;
const PAD_Y = 0.2, PAD_X = 0.3, WIDTH_MULTIPLE = 8, MAX_LINE_WIDTH = 4096;
const MAX_LINES = 400;
const DESKEW_MAX = 45, DESKEW_MIN = .3, PREVIEW_SIDE = 1600, SKEW_SIDE = 800;

// Python's round(): half to even, so sizes match the reference implementation.
function pyRound(value: number): number {
  const floor = Math.floor(value), diff = value - floor;
  if (diff > .5) return floor + 1;
  if (diff < .5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** OpenCV COLOR_RGB2GRAY fixed-point weights. */
function toGray(canvas: HTMLCanvasElement): Gray {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Canvas unavailable');
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const rgba = image.data;
  const data = new Uint8Array(canvas.width * canvas.height);
  for (let i = 0, j = 0; j < data.length; i += 4, j++) data[j] = (rgba[i] * 4899 + rgba[i + 1] * 9617 + rgba[i + 2] * 1868 + 8192) >> 14;
  rgba.fill(0);
  return { data, width: canvas.width, height: canvas.height };
}

/** Per-axis source taps for one output size: area weights when shrinking, linear otherwise. */
function axisWeights(source: number, target: number, area: boolean): { start: Int32Array; count: Int32Array; index: Int32Array; weight: Float32Array } {
  const scale = source / target;
  const start = new Int32Array(target), count = new Int32Array(target);
  const index: number[] = [], weight: number[] = [];
  for (let x = 0; x < target; x++) {
    start[x] = index.length;
    if (area && scale > 1) {
      const begin = x * scale, end = Math.min(source, (x + 1) * scale);
      for (let s = Math.floor(begin); s < Math.ceil(end); s++) {
        const w = Math.min(end, s + 1) - Math.max(begin, s);
        if (w > 1e-6) { index.push(s); weight.push(w / (end - begin)); }
      }
    } else {
      let position = (x + .5) * scale - .5;
      let left = Math.floor(position);
      let fraction = position - left;
      if (left < 0) { left = 0; fraction = 0; }
      if (left >= source - 1) { left = source - 1; fraction = 0; }
      index.push(left); weight.push(1 - fraction);
      if (fraction > 0) { index.push(left + 1); weight.push(fraction); }
    }
    count[x] = index.length - start[x];
  }
  return { start, count, index: Int32Array.from(index), weight: Float32Array.from(weight) };
}

/** Separable resize of 8-bit gray pixels, rounded back to 8 bits like cv2.resize. */
function resize(source: Gray, width: number, height: number, area: boolean): Gray {
  if (source.width === width && source.height === height) return { data: source.data.slice(), width, height };
  const xs = axisWeights(source.width, width, area), ys = axisWeights(source.height, height, area);
  const rows = new Float32Array(source.height * width);
  for (let y = 0; y < source.height; y++) {
    const row = y * source.width;
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = xs.start[x], end = k + xs.count[x]; k < end; k++) sum += source.data[row + xs.index[k]] * xs.weight[k];
      rows[y * width + x] = sum;
    }
  }
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = ys.start[y], end = k + ys.count[y]; k < end; k++) sum += rows[ys.index[k] * width + x] * ys.weight[k];
      data[y * width + x] = Math.max(0, Math.min(255, Math.round(sum)));
    }
  }
  rows.fill(0);
  return { data, width, height };
}

/** cv2.warpAffine of a rotation about the centre (pixel centres on integers), bilinear.
 * Outside the source is 0 (`replicate` false) or the nearest edge pixel. */
function rotate(source: Gray, degrees: number, replicate: boolean): Uint8Array {
  const { width, height, data } = source;
  const radians = degrees * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians);
  const cx = width / 2, cy = height / 2;
  const out = new Uint8Array(width * height);
  const pixel = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) {
      if (!replicate) return 0;
      x = Math.min(width - 1, Math.max(0, x)); y = Math.min(height - 1, Math.max(0, y));
    }
    return data[y * width + x];
  };
  for (let y = 0; y < height; y++) {
    const dy = y - cy;
    for (let x = 0; x < width; x++) {
      const dx = x - cx;
      const sx = cx + cos * dx - sin * dy, sy = cy + sin * dx + cos * dy;
      const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
      if (!replicate && (x0 < -1 || y0 < -1 || x0 >= width || y0 >= height)) continue;
      const top = pixel(x0, y0) * (1 - fx) + pixel(x0 + 1, y0) * fx;
      const bottom = pixel(x0, y0 + 1) * (1 - fx) + pixel(x0 + 1, y0 + 1) * fx;
      out[y * width + x] = Math.round(top * (1 - fy) + bottom * fy);
    }
  }
  return out;
}

/** Ink map (255 = ink) of the page shrunk to `side` pixels. */
function inkThumb(gray: Gray, side: number): Gray {
  const scale = side / Math.max(gray.width, gray.height);
  const small = resize(gray, Math.max(1, pyRound(gray.width * scale)), Math.max(1, pyRound(gray.height * scale)), true);
  for (let i = 0; i < small.data.length; i++) small.data[i] = 255 - small.data[i];
  return small;
}

/** How sharply the horizontal ink profile changes row to row after turning by `degrees`. */
function rowSharpness(ink: Gray, degrees: number): number {
  const turned = rotate(ink, degrees, false);
  let previous = 0, total = 0;
  for (let y = 0; y < ink.height; y++) {
    let sum = 0;
    for (let x = 0, i = y * ink.width; x < ink.width; x++, i++) sum += turned[i];
    if (y) total += (sum - previous) ** 2;
    previous = sum;
  }
  turned.fill(0);
  return total;
}

/** pipeline.estimate_skew: degrees (counter-clockwise) that level the text rows. */
function estimateSkew(gray: Gray): number {
  const fine = inkThumb(gray, SKEW_SIDE);
  try {
    let ink = 0;
    for (const value of fine.data) ink += value;
    if (ink / fine.data.length < .003 * 255) return 0;
    const coarse = inkThumb(gray, SKEW_SIDE >> 1);
    const grid = Array.from({ length: Math.floor(2 * DESKEW_MAX / 2) + 1 }, (_, i) => -DESKEW_MAX + 2 * i);
    const coarseScores = grid.map(angle => rowSharpness(coarse, angle));
    coarse.data.fill(0);
    const best = grid.map((_, i) => i).sort((a, b) => coarseScores[a] - coarseScores[b]).slice(-2).map(i => grid[i]);
    const near = [...new Set([0, ...best])].flatMap(start => Array.from({ length: 9 }, (_, i) => start - 2 + .5 * i));
    const scores = new Map<number, number>();
    for (const angle of near) if (!scores.has(angle)) scores.set(angle, rowSharpness(fine, angle));
    const middle = near.reduce((best, angle) => scores.get(angle)! > scores.get(best)! ? angle : best, near[0]);
    let skew = middle - .5, top = -Infinity;
    for (let i = 0; i <= 10; i++) {
      const angle = middle - .5 + .1 * i, score = rowSharpness(fine, angle);
      if (score > top) { top = score; skew = angle; }
    }
    return skew;
  } finally {
    fine.data.fill(0);
  }
}

/**
 * A level copy of a tilted page (cv2.warpAffine, edge pixels replicated), or null when
 * the text rows are already level. Callers crop fields from the returned frame.
 */
export function straighten(canvas: HTMLCanvasElement): HTMLCanvasElement | null {
  const gray = toGray(canvas);
  let preview: Gray | undefined;
  try {
    const scale = PREVIEW_SIDE / Math.max(gray.width, gray.height);
    preview = scale < 1 ? resize(gray, Math.max(1, pyRound(gray.width * scale)), Math.max(1, pyRound(gray.height * scale)), true) : gray;
    const skew = estimateSkew(preview);
    if (Math.abs(skew) < DESKEW_MIN) return null;
    const level = rotate(gray, skew, true);
    const output = document.createElement('canvas');
    output.width = gray.width; output.height = gray.height;
    const context = output.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Canvas unavailable');
    const image = context.createImageData(gray.width, gray.height);
    for (let i = 0, j = 0; j < level.length; i += 4, j++) {
      image.data[i] = image.data[i + 1] = image.data[i + 2] = level[j];
      image.data[i + 3] = 255;
    }
    context.putImageData(image, 0, 0);
    image.data.fill(0); level.fill(0);
    return output;
  } finally {
    if (preview && preview !== gray) preview.data.fill(0);
    gray.data.fill(0);
  }
}

/** Light text on a dark ground is read inverted (rec_preproc.is_dark_line). */
function isDarkLine(gray: Gray, box: Box): boolean {
  const x0 = Math.max(0, Math.trunc(box[0])), y0 = Math.max(0, Math.trunc(box[1]));
  const x1 = Math.min(gray.width, Math.trunc(box[2]) + 1), y1 = Math.min(gray.height, Math.trunc(box[3]) + 1);
  if (x1 <= x0 || y1 <= y0) return false;
  const histogram = new Float64Array(256);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) histogram[gray.data[y * gray.width + x]]++;
  const n = (x1 - x0) * (y1 - y0);
  const cumulative = new Float64Array(256);
  for (let i = 0, total = 0; i < 256; i++) cumulative[i] = total += histogram[i];
  // np.searchsorted(cumulative, value, side='right')
  const rank = (value: number) => { let i = 0; while (i < 256 && cumulative[i] <= value) i++; return i; };
  const [lo, median, hi] = [.02, .5, .98].map(q => {
    const position = q * (n - 1), i = Math.floor(position), g = position - i;
    const low = rank(i), high = rank(Math.min(i + 1, n - 1)), d = high - low;
    return g >= .5 ? high - d * (1 - g) : low + d * g;
  });
  return hi - median > 2 * (median - lo) + 8;
}

/** rec_preproc.crop_line: a [window * 32, W] ink map, white (or dark) outside the page. */
function cropLine(gray: Gray, box: Box, lineHeight: number, window: number, dark: boolean): { ink: Float32Array; width: number; height: number } {
  const padY = (window * (1 + 2 * PAD_Y) - 1) / 2;
  const height = lineHeight * window;
  const h = Math.max(1, box[3] - box[1]);
  const ix0 = Math.floor(box[0] - PAD_X * h), iy0 = Math.floor(box[1] - padY * h);
  const ix1 = Math.ceil(box[2] + PAD_X * h), iy1 = Math.ceil(box[3] + padY * h);
  const cw = Math.max(1, ix1 - ix0), ch = Math.max(1, iy1 - iy0);
  const crop: Gray = { data: new Uint8Array(cw * ch).fill(dark ? 0 : 255), width: cw, height: ch };
  const sx0 = Math.max(0, ix0), sy0 = Math.max(0, iy0), sx1 = Math.min(gray.width, ix1), sy1 = Math.min(gray.height, iy1);
  for (let y = sy0; y < sy1; y++) {
    if (sx1 > sx0) crop.data.set(gray.data.subarray(y * gray.width + sx0, y * gray.width + sx1), (y - iy0) * cw + (sx0 - ix0));
  }
  const width = Math.max(WIDTH_MULTIPLE, Math.min(MAX_LINE_WIDTH, pyRound(cw * height / ch)));
  const resized = resize(crop, width, height, ch > height);
  crop.data.fill(0);
  const ink = new Float32Array(width * height);
  for (let i = 0; i < ink.length; i++) ink[i] = dark ? resized.data[i] / 255 : 1 - resized.data[i] / 255;
  resized.data.fill(0);
  return { ink, width, height };
}

/** The window-1 crop width, used for batching and CTC position mapping. */
function lineWidth(box: Box, lineHeight: number): number {
  const h = Math.max(1, box[3] - box[1]);
  const cw = Math.max(1, Math.ceil(box[2] + PAD_X * h) - Math.floor(box[0] - PAD_X * h));
  const ch = Math.max(1, Math.ceil(box[3] + PAD_Y * h) - Math.floor(box[1] - PAD_Y * h));
  return Math.max(WIDTH_MULTIPLE, Math.min(MAX_LINE_WIDTH, pyRound(cw * lineHeight / ch)));
}

/** rec_preproc.width_batches */
function widthBatches(widths: number[], maxBatch = 64, maxRatio = 1.3, minWidth = 64, maxArea = 64 * 640): number[][] {
  const order = widths.map((_, i) => i).sort((a, b) => widths[a] - widths[b] || a - b);
  const batches: number[][] = [];
  for (const i of order) {
    const last = batches[batches.length - 1];
    if (last && last.length < maxBatch && Math.max(widths[i], minWidth) <= maxRatio * Math.max(widths[last[0]], minWidth)
      && (last.length + 1) * Math.max(widths[i], minWidth) <= maxArea) last.push(i);
    else batches.push([i]);
  }
  return batches;
}

/** det_post.decode: core-band components to line boxes, in detector input pixels. */
function decodeLines(out: Float32Array, h: number, w: number): Box[] {
  const plane = h * w;
  const labels = new Int32Array(plane);
  const stack = new Int32Array(plane);
  const boxes: Box[] = [];
  const probability = (i: number) => 1 / (1 + Math.exp(-out[i]));
  for (let seed = 0; seed < plane; seed++) {
    if (labels[seed] || probability(seed) <= .5) continue;
    let top = 0, bottom = 0, count = 0, left = w, right = -1, size = 0;
    labels[seed] = 1; stack[size++] = seed;
    while (size) {
      const i = stack[--size];
      const y = (i / w) | 0, x = i - y * w;
      const center = (y + .5) * OUT_STRIDE;
      top += center - out[plane + i]; bottom += center + out[2 * plane + i]; count++;
      if (x < left) left = x;
      if (x > right) right = x;
      for (const next of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (next >= 0 && !labels[next] && probability(next) > .5) { labels[next] = 1; stack[size++] = next; }
      }
    }
    if (count < 2) continue;
    const y0 = top / count, y1 = bottom / count;
    const lineHeight = Math.max(1, y1 - y0);
    const extend = Math.min(CORE_X_SHRINK * lineHeight, .5 * lineHeight);
    boxes.push([left * OUT_STRIDE - extend, y0, (right + 1) * OUT_STRIDE + extend, y1]);
  }
  return boxes;
}

// The proxy worker takes ownership of transferred input buffers, leaving them detached here.
const wipe = (array: Float32Array | BigInt64Array) => {
  if (!array.buffer.byteLength) return;
  if (array instanceof BigInt64Array) array.fill(0n); else array.fill(0);
};
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

class IndraReader implements OCRReader {
  private det?: Session;
  private rec?: Session;
  private chars: string[] = [];
  private space = -1;
  private hasCommands = false;
  private longSide = 1024;
  private lineHeight = 32;
  private window = 1;
  private closed = false;

  constructor(private readonly runtime: Runtime) {}

  async load(): Promise<void> {
    const ort = this.runtime;
    ort.env.wasm.wasmPaths = OCR_ASSETS.runtime;
    // Without cross-origin isolation the runtime cannot share memory between threads.
    ort.env.wasm.numThreads = 1;
    // Inference runs in the runtime's own worker so the page stays responsive.
    ort.env.wasm.proxy = true;
    const fetchBytes = async (name: string) => {
      const response = await fetch(OCR_ASSETS.models + name, { credentials: 'same-origin' });
      if (!response.ok) throw new Error('OCR model unavailable');
      return new Uint8Array(await response.arrayBuffer());
    };
    const [det, rec, metaBytes] = await Promise.all([fetchBytes('det.onnx'), fetchBytes('rec.onnx'), fetchBytes('meta.json')]);
    const meta = JSON.parse(new TextDecoder().decode(metaBytes)) as { vocab: string; det_long_side: number; rec_height: number; rec_window?: number };
    const vocab = JSON.parse(meta.vocab) as { blank?: number; chars: string[] };
    if ((vocab.blank ?? 0) !== 0 || !Array.isArray(vocab.chars)) throw new Error('Unsupported OCR vocabulary');
    this.chars = vocab.chars;
    this.space = vocab.chars.indexOf(' ') + 1;
    this.hasCommands = vocab.chars.some(token => token.length > 1);
    this.longSide = meta.det_long_side;
    this.lineHeight = meta.rec_height;
    this.window = meta.rec_window ?? 1;
    const options = { executionProviders: ['wasm'], graphOptimizationLevel: 'all', enableCpuMemArena: false };
    this.det = await ort.InferenceSession.create(det, options);
    this.rec = await ort.InferenceSession.create(rec, options);
    if (this.closed) this.terminate();
  }

  private async detectAt(gray: Gray, longSide: number): Promise<{ boxes: Box[]; scale: number }> {
    const scale = longSide / Math.max(gray.width, gray.height);
    const width = Math.max(1, pyRound(gray.width * scale)), height = Math.max(1, pyRound(gray.height * scale));
    const resized = resize(gray, width, height, scale < 1);
    const paddedWidth = Math.ceil(width / INPUT_MULTIPLE) * INPUT_MULTIPLE, paddedHeight = Math.ceil(height / INPUT_MULTIPLE) * INPUT_MULTIPLE;
    const input = new Float32Array(paddedWidth * paddedHeight);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) input[y * paddedWidth + x] = 1 - resized.data[y * width + x] / 255;
    resized.data.fill(0);
    const outputs = await this.det!.run({ x: new this.runtime.Tensor('float32', input, [1, 1, paddedHeight, paddedWidth]) });
    wipe(input);
    const out = outputs.out;
    const boxes = decodeLines(out.data as Float32Array, out.dims[2], out.dims[3]);
    wipe(out.data);
    out.dispose?.();
    return { boxes, scale };
  }

  /** Line boxes in page pixels. */
  private async detect(gray: Gray): Promise<Box[]> {
    const first = Math.min(this.longSide, Math.ceil(Math.max(gray.width, gray.height) / INPUT_MULTIPLE) * INPUT_MULTIPLE);
    let { boxes, scale } = await this.detectAt(gray, first);
    if (boxes.length) {
      const lineHeight = median(boxes.map(box => box[3] - box[1]));
      const target = lineHeight < ADAPTIVE_MIN_H ? ADAPTIVE_TARGET_H : lineHeight > DETECT_MAX_H ? DETECT_TARGET_H : 0;
      if (target) {
        const next = Math.max(64, Math.floor(Math.min(ADAPTIVE_MAX_SIDE, first * target / Math.max(lineHeight, 1)) / INPUT_MULTIPLE) * INPUT_MULTIPLE);
        if (next !== first) ({ boxes, scale } = await this.detectAt(gray, next));
      }
    }
    return boxes.map(box => [
      Math.min(gray.width, Math.max(0, box[0] / scale)), Math.min(gray.height, Math.max(0, box[1] / scale)),
      Math.min(gray.width, Math.max(0, box[2] / scale)), Math.min(gray.height, Math.max(0, box[3] / scale)),
    ] as Box).filter(box => box[2] > box[0] && box[3] > box[1]);
  }

  private decode(ids: number[]): string {
    const tokens = ids.filter(id => id > 0 && id <= this.chars.length).map(id => this.chars[id - 1]);
    if (!this.hasCommands) return tokens.join('');
    return tokens.map((token, k) => {
      const next = tokens[k + 1] ?? '';
      return token.length > 2 && token[0] === '\\' && /^[A-Za-z]+$/.test(token.slice(1)) && /^[A-Za-z]/.test(next) ? token + ' ' : token;
    }).join('');
  }

  private async recognizeLines(gray: Gray, boxes: Box[], onProgress?: (progress: number) => void): Promise<Line[]> {
    const lines: Line[] = boxes.map(box => ({ box, text: '', conf: 0, tokens: [] }));
    const widths = boxes.map(box => lineWidth(box, this.lineHeight));
    const batches = widthBatches(widths);
    for (const [done, batch] of batches.entries()) {
      if (this.closed) throw new Error('OCR closed');
      const crops = batch.map(j => cropLine(gray, boxes[j], this.lineHeight, this.window, isDarkLine(gray, boxes[j])));
      const height = crops[0].height;
      const maxWidth = Math.ceil(Math.max(...crops.map(crop => crop.width)) / WIDTH_MULTIPLE) * WIDTH_MULTIPLE;
      const input = new Float32Array(batch.length * height * maxWidth);
      crops.forEach((crop, b) => {
        for (let y = 0; y < height; y++) input.set(crop.ink.subarray(y * crop.width, (y + 1) * crop.width), (b * height + y) * maxWidth);
        crop.ink.fill(0);
      });
      const outputs = await this.rec!.run({
        x: new this.runtime.Tensor('float32', input, [batch.length, 1, height, maxWidth]),
        widths: new this.runtime.Tensor('int64', BigInt64Array.from(crops.map(crop => BigInt(crop.width))), [batch.length]),
      }, ['ids', 'conf', 'lengths']);
      wipe(input);
      const ids = outputs.ids.data as BigInt64Array, peaks = outputs.conf.data as Float32Array, lengths = outputs.lengths.data as BigInt64Array;
      const steps = outputs.ids.dims[1];
      const stride = maxWidth / Math.max(steps, 1);
      batch.forEach((j, b) => {
        const n = Number(lengths[b]);
        const box = boxes[j];
        const h = Math.max(1, box[3] - box[1]);
        const ix0 = Math.floor(box[0] - PAD_X * h);
        const factor = (Math.ceil(box[2] + PAD_X * h) - ix0) / widths[j];
        const tokens: Token[] = [];
        let total = 0;
        for (let t = 0, previous = 0; t < n; t++) {
          const id = Number(ids[b * steps + t]);
          if (id !== 0 && id !== previous) {
            tokens.push({ id, x: ix0 + (t + .5) * stride * factor });
            total += peaks[b * steps + t];
          }
          previous = id;
        }
        const conf = tokens.length ? total / tokens.length : 0;
        lines[j] = conf >= MIN_CONF ? { box, text: this.decode(tokens.map(token => token.id)), conf, tokens } : { box, text: '', conf, tokens: [] };
      });
      wipe(ids); wipe(peaks);
      for (const output of Object.values(outputs)) output.dispose?.();
      onProgress?.((done + 1) / batches.length);
    }
    return lines;
  }

  /** pipeline.split_line at SPLIT_GAP: a detector line that spans separate fields. */
  private splitLine(line: Line): Line[] {
    const h = Math.max(1, line.box[3] - line.box[1]);
    const segments: Token[][] = [[]];
    let previous: number | null = null;
    for (const token of line.tokens) {
      if (token.id !== this.space) {
        if (previous !== null && token.x - previous > SPLIT_GAP * h) segments.push([]);
        previous = token.x;
      }
      segments[segments.length - 1].push(token);
    }
    if (segments.length === 1) return [line];
    return segments.flatMap(tokens => {
      const text = this.decode(tokens.map(token => token.id)).trim();
      const xs = tokens.filter(token => token.id !== this.space).map(token => token.x);
      if (!text || !xs.length) return [];
      const box: Box = [Math.max(line.box[0], Math.min(...xs) - .35 * h), line.box[1], Math.min(line.box[2], Math.max(...xs) + .35 * h), line.box[3]];
      return [{ box, text, conf: line.conf, tokens }];
    });
  }

  /** Space-separated words with boxes from CTC character positions. */
  private words(line: Line): OCRWord[] {
    const h = Math.max(1, line.box[3] - line.box[1]);
    const groups: Token[][] = [];
    let current: Token[] = [];
    for (const token of line.tokens) {
      if (token.id === this.space) { if (current.length) groups.push(current); current = []; } else current.push(token);
    }
    if (current.length) groups.push(current);
    return groups.map(tokens => {
      const x0 = Math.max(line.box[0], tokens[0].x - .35 * h), x1 = Math.min(line.box[2], tokens[tokens.length - 1].x + .35 * h);
      return { text: this.decode(tokens.map(token => token.id)), confidence: Math.round(line.conf * 100), bbox: { x0, y0: line.box[1], x1, y1: line.box[3] } };
    }).filter(word => word.text.trim() && word.bbox.x1 > word.bbox.x0);
  }

  async recognize(image: HTMLCanvasElement, onProgress?: (progress: number) => void): Promise<OCRResult> {
    if (!this.det || !this.rec || this.closed) throw new Error('OCR not loaded');
    const gray = toGray(image);
    try {
      const boxes = (await this.detect(gray)).slice(0, MAX_LINES);
      const lines = (await this.recognizeLines(gray, boxes, onProgress)).flatMap(line => line.text ? this.splitLine(line) : []);
      // Physical rows, top to bottom, then left to right inside a row.
      const rows: Line[][] = [];
      for (const line of [...lines].sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0])) {
        const height = (box: Box) => box[3] - box[1];
        const row = rows.find(row => Math.min(row[0].box[3], line.box[3]) - Math.max(row[0].box[1], line.box[1]) >= Math.min(height(row[0].box), height(line.box)) * .45);
        if (row) row.push(line); else rows.push([line]);
      }
      const text = rows.map(row => row.sort((a, b) => a.box[0] - b.box[0]).map(line => line.text.trim()).join(' ')).join('\n');
      const words = rows.flat().flatMap(line => this.words(line));
      for (const line of lines) line.tokens.length = 0;
      return { data: { text, words } };
    } finally {
      gray.data.fill(0);
    }
  }

  terminate(): void {
    this.closed = true;
    for (const session of [this.det, this.rec]) void session?.release?.().catch(() => {});
    this.det = this.rec = undefined;
  }
}

/** The runtime script (`ort.wasm.min.js`) must already be loaded on the page. */
export function createOCRReader(): OCRReader {
  const runtime = (globalThis as unknown as { ort?: Runtime }).ort;
  if (!runtime?.InferenceSession || !runtime.Tensor) throw new Error('OCR runtime unavailable');
  return new IndraReader(runtime);
}
