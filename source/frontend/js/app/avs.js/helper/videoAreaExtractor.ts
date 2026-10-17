namespace Avs {
	export namespace Helper {
		export class VideoAreaExtractor {
			/** Map a guide in viewport CSS pixels to the original, center-cropped camera frame. */
			public static mapMaskToSource(
				mask: { left: number; top: number; width: number; height: number },
				video: { left: number; top: number; width: number; height: number },
				mediaWidth: number,
				mediaHeight: number,
				mirrored: boolean = false,
			): IVideoMaskPosition {
				if (
					![
						mask.left,
						mask.top,
						mask.width,
						mask.height,
						video.left,
						video.top,
						video.width,
						video.height,
						mediaWidth,
						mediaHeight,
					].every((value) => isFinite(value)) ||
					mediaWidth <= 0 ||
					mediaHeight <= 0 ||
					video.width <= 0 ||
					video.height <= 0 ||
					mask.width <= 0 ||
					mask.height <= 0
				)
					throw new Error("Camera frame not ready");
				const scale = Math.max(
					video.width / mediaWidth,
					video.height / mediaHeight,
				);
				const width = mask.width / scale,
					height = mask.height / scale;
				let left =
					(mask.left - video.left) / scale +
					(mediaWidth - video.width / scale) / 2;
				const top =
					(mask.top - video.top) / scale +
					(mediaHeight - video.height / scale) / 2;
				if (mirrored) left = mediaWidth - left - width;
				const clippedLeft = Math.max(0, left),
					clippedTop = Math.max(0, top);
				return {
					left: clippedLeft,
					top: clippedTop,
					width: Math.max(0, Math.min(mediaWidth, left + width) - clippedLeft),
					height: Math.max(0, Math.min(mediaHeight, top + height) - clippedTop),
					scalePercent: scale * 100,
				};
			}

			public static calculateMaskPosition(
				maskElement: HTMLElement,
				videoElement: HTMLElement,
			): IVideoMaskPosition {
				const mask = maskElement.getBoundingClientRect(),
					video = videoElement.getBoundingClientRect();
				const style = window.getComputedStyle(maskElement);
				const left = parseFloat(style.borderLeftWidth) || 0,
					right = parseFloat(style.borderRightWidth) || 0;
				const top = parseFloat(style.borderTopWidth) || 0,
					bottom = parseFloat(style.borderBottomWidth) || 0;
				return this.mapMaskToSource(
					{
						left: mask.left + left,
						top: mask.top + top,
						width: mask.width - left - right,
						height: mask.height - top - bottom,
					},
					video,
					(<HTMLVideoElement>videoElement).videoWidth,
					(<HTMLVideoElement>videoElement).videoHeight,
					videoElement.classList.contains("mirrored"),
				);
			}

			public static videoMaskToCanvas(
				videoElement: HTMLElement,
				canvasElement: HTMLElement,
				maskPosition: IVideoMaskPosition,
				canvasZoom?: number,
			) {
				let canvasZoomValue = canvasZoom || 1;

				let videoElementInstance = $(videoElement);
				let canvasElementInstance = $(canvasElement);
				(<HTMLCanvasElement>canvasElementInstance.get(0)).width =
					maskPosition.width * canvasZoomValue;
				(<HTMLCanvasElement>canvasElementInstance.get(0)).height =
					maskPosition.height * canvasZoomValue;

				let contextCanvasBirthDate = (<HTMLCanvasElement>(
					canvasElementInstance.get(0)
				)).getContext("2d");
				(<CanvasRenderingContext2D>contextCanvasBirthDate).drawImage(
					<HTMLVideoElement>videoElementInstance.get(0),
					maskPosition.left,
					maskPosition.top,
					maskPosition.width,
					maskPosition.height,
					0,
					0,
					maskPosition.width * canvasZoomValue,
					maskPosition.height * canvasZoomValue,
				);

				return <HTMLCanvasElement>canvasElementInstance.get(0);
			}
		}

		export interface IVideoMaskPosition {
			top: number;
			left: number;
			width: number;
			height: number;
			scalePercent: number;
		}
	}
}
