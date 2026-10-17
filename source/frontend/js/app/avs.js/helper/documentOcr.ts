namespace Avs.Helper {
	/** Repeatable, bounded attempts; always try the original pixels before enhancing them. */
	export class DocumentOcr {
		public static clampRegion(
			region: Avs.Helper.IVideoMaskPosition,
			width: number,
			height: number,
		): Avs.Helper.IVideoMaskPosition {
			if (
				![
					region.left,
					region.top,
					region.width,
					region.height,
					width,
					height,
				].every((value) => isFinite(value)) ||
				width < 1 ||
				height < 1 ||
				region.width <= 0 ||
				region.height <= 0
			)
				throw new Error("Invalid crop dimensions");
			const left = Math.max(0, Math.min(width - 1, region.left)),
				top = Math.max(0, Math.min(height - 1, region.top));
			return {
				left,
				top,
				width: Math.max(1, Math.min(region.width, width - left)),
				height: Math.max(1, Math.min(region.height, height - top)),
				scalePercent: 1,
			};
		}

		public static attempt(index: number, variantCount: number) {
			const pass = Math.floor(index / Math.max(1, variantCount));
			const profile = pass % 4;
			const scales = [0, -0.05, 0.05, -0.1, 0.1];
			return {
				profile,
				grayscale: profile !== 0,
				brightness: profile === 3 ? 10 : 0,
				contrast: profile >= 2 ? 20 : 0,
				scaleAdjustment: scales[Math.floor(pass / 4) % scales.length],
				pageSegmentation: profile % 2 === 0 ? 6 : 7,
			};
		}
	}
}
