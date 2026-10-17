/** Independently authored pixel-selection primitives. Coordinates are never document data. */
export type NormalizedCrop = { x: number; y: number; width: number; height: number };
export type PixelCrop = NormalizedCrop;

export function normalizeCrop(crop: NormalizedCrop): NormalizedCrop {
  if (!crop || ![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite) || crop.width <= 0 || crop.height <= 0) {
    throw new RangeError('The selected image region is invalid.');
  }
  const x = Math.max(0, crop.x);
  const y = Math.max(0, crop.y);
  const right = Math.min(1, crop.x + crop.width);
  const bottom = Math.min(1, crop.y + crop.height);
  if (right <= x || bottom <= y) throw new RangeError('The selected image region is empty.');
  return { x, y, width: right - x, height: bottom - y };
}

/** Cover the selected native pixels, including partial edge pixels. */
export function cropToPixels(crop: NormalizedCrop, width: number, height: number): PixelCrop {
  if (![width, height].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new RangeError('The image is not ready.');
  }
  const bounded = normalizeCrop(crop);
  const x = Math.floor(bounded.x * width);
  const y = Math.floor(bounded.y * height);
  const right = Math.min(width, Math.max(x + 1, Math.ceil((bounded.x + bounded.width) * width - Number.EPSILON * width * 4)));
  const bottom = Math.min(height, Math.max(y + 1, Math.ceil((bounded.y + bounded.height) * height - Number.EPSILON * height * 4)));
  return { x, y, width: right - x, height: bottom - y };
}
