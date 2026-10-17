/** Advisory capture checks, not a document detector or an OCR/identity decision. */
export type DocumentQualityIssue = 'resolution' | 'detail' | 'highlights';
export type DocumentQuality = { issues: DocumentQualityIssue[] };

// Testable pixel analysis. Callers own and clear pixels after use. Thresholds are
// intentionally conservative: a warning can always be bypassed by the visitor.
export function assessDocumentPixels(pixels: Uint8ClampedArray, width: number, height: number, originalWidth = width, originalHeight = height): DocumentQuality {
  const issues: DocumentQualityIssue[] = [];
  if (!width || !height || pixels.length < width * height * 4) return { issues };
  const luminance = new Float32Array(width * height);
  try {
    let opaque = 0;
    let bright = 0;
    let sum = 0;
    let squared = 0;
    for (let index = 0; index < luminance.length; index++) {
      const offset = index * 4;
      if (pixels[offset + 3] < 240) continue;
      opaque++;
      const value = 0.2126 * pixels[offset] + 0.7152 * pixels[offset + 1] + 0.0722 * pixels[offset + 2];
      luminance[index] = value;
      sum += value;
      squared += value * value;
      if (pixels[offset] >= 250 && pixels[offset + 1] >= 250 && pixels[offset + 2] >= 250) bright++;
    }
    // Transparent/unsupported samples cannot give useful exposure or focus advice.
    if (opaque < luminance.length * 0.98) return { issues };
    if (Math.max(originalWidth, originalHeight) < 800 || Math.min(originalWidth, originalHeight) < 400) issues.push('resolution');
    let edgeEnergy = 0;
    let count = 0;
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const index = y * width + x;
        const laplacian = luminance[index - 1] + luminance[index + 1] + luminance[index - width] + luminance[index + width] - 4 * luminance[index];
        edgeEnergy += laplacian * laplacian;
        count++;
      }
    }
    edgeEnergy /= Math.max(count, 1);
    const mean = sum / opaque;
    const variation = Math.max(0, squared / opaque - mean * mean);
    // White paper with dark text should not be classified as glare. This only
    // warns about near-blank clipped images, not ordinary bright card backgrounds.
    if (bright / opaque > 0.98 && edgeEnergy < 12) issues.push('highlights');
    else if (edgeEnergy < 6 || (variation < 16 && edgeEnergy < 20)) issues.push('detail');
    return { issues };
  } finally { luminance.fill(0); }
}

export function inspectDocumentQuality(image: HTMLCanvasElement): DocumentQuality {
  const sample = document.createElement('canvas');
  let pixels: Uint8ClampedArray | undefined;
  try {
    const scale = Math.min(1, 720 / Math.max(image.width, image.height));
    sample.width = Math.max(1, Math.round(image.width * scale));
    sample.height = Math.max(1, Math.round(image.height * scale));
    const context = sample.getContext('2d', { willReadFrequently: true });
    if (!context) return { issues: [] };
    context.drawImage(image, 0, 0, sample.width, sample.height);
    pixels = context.getImageData(0, 0, sample.width, sample.height).data;
    return assessDocumentPixels(pixels, sample.width, sample.height, image.width, image.height);
  } catch {
    // Quality advice must never prevent an otherwise usable image from being read.
    return { issues: [] };
  } finally {
    pixels?.fill(0);
    sample.width = sample.height = 0;
  }
}

export function documentQualityAdvice(issue: DocumentQualityIssue): string {
  if (issue === 'resolution') return 'This image is small. Move closer so the document fills the frame, or choose a higher-resolution image.';
  if (issue === 'highlights') return 'The image is very bright and may hide the text. Tilt the document away from reflections and reduce direct light.';
  return 'The image has very little sharp detail. Clean the lens, hold the document steady and make sure its text is in focus.';
}
