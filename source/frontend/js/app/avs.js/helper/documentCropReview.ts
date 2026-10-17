namespace Avs.Helper {
	/** Local-only image selection. No serialization, uploads, storage, or extracted-text display. */
	export class DocumentCropReview {
		private panel: HTMLElement;
		private canvas: HTMLCanvasElement;
		private preview: HTMLCanvasElement;
		private source: HTMLCanvasElement;
		private region: Avs.Helper.IVideoMaskPosition;
		private start: { x: number; y: number } = null;

		constructor(
			container: HTMLElement,
			source: HTMLCanvasElement,
			initial: Avs.Helper.IVideoMaskPosition,
			onConfirm: (region: Avs.Helper.IVideoMaskPosition) => void,
			onRetake: () => void,
			onCancel: () => void,
		) {
			this.source = source;
			const fallback = {
				left: source.width * 0.35,
				top: source.height * 0.4,
				width: source.width * 0.35,
				height: source.height * 0.15,
				scalePercent: 1,
			};
			try {
				this.region = DocumentOcr.clampRegion(
					initial || fallback,
					source.width,
					source.height,
				);
			} catch (error) {
				this.region = DocumentOcr.clampRegion(
					fallback,
					source.width,
					source.height,
				);
			}

			this.panel = document.createElement("section");
			this.panel.className = "tv-crop-review";
			this.panel.setAttribute("aria-labelledby", "tv-crop-heading");
			this.panel.innerHTML = `<h2 id="tv-crop-heading" tabindex="-1">Help us locate your birth date</h2>
				<p>We couldn't read the date from the automatic selection. Draw a box around your <strong>date of birth</strong>, keeping the entire date visible. Choose the birth date, not the issue or expiration date.</p>
				<p class="tv-crop-private">Your photo stays in this browser. Nothing here is uploaded.</p>
				<canvas class="tv-crop-image" aria-label="Document photo with selected reading area"></canvas>
				<details><summary>Adjust the box with sliders</summary><div class="tv-crop-controls">
				<label>Horizontal position<input type="range" min="0" max="99" step="0.5" data-field="left"></label>
				<label>Vertical position<input type="range" min="0" max="99" step="0.5" data-field="top"></label>
				<label>Box width<input type="range" min="1" max="100" step="0.5" data-field="width"></label>
				<label>Box height<input type="range" min="1" max="100" step="0.5" data-field="height"></label>
				</div></details>
				<h3>Area we will read</h3><canvas class="tv-crop-preview" aria-label="Preview of selected birth date area"></canvas>
				<p>Check that the date is sharp and complete. If it is blurry or missing, start over with a clearer photo.</p>
				<div class="tv-crop-actions"><button type="button" data-action="read">Read selected area</button>
				<button type="button" data-action="retake">Start over with a new photo</button>
				<button type="button" data-action="cancel">Cancel verification</button></div>`;
			container.appendChild(this.panel);
			this.canvas = this.panel.querySelector(".tv-crop-image");
			this.preview = this.panel.querySelector(".tv-crop-preview");
			const scale = Math.min(1, 1000 / source.width);
			this.canvas.width = Math.round(source.width * scale);
			this.canvas.height = Math.round(source.height * scale);
			this.panel
				.querySelectorAll<HTMLInputElement>("input")
				.forEach((input) => {
					input.addEventListener("input", () => {
						const field = input.getAttribute("data-field");
						const horizontal = field === "left" || field === "width";
						(<any>this.region)[field] =
							(Number(input.value) / 100) *
							(horizontal ? source.width : source.height);
						this.region = DocumentOcr.clampRegion(
							this.region,
							source.width,
							source.height,
						);
						this.draw();
					});
				});
			const point = (event: PointerEvent) => {
				const bounds = this.canvas.getBoundingClientRect();
				return {
					x: Math.max(
						0,
						Math.min(
							source.width,
							((event.clientX - bounds.left) / bounds.width) * source.width,
						),
					),
					y: Math.max(
						0,
						Math.min(
							source.height,
							((event.clientY - bounds.top) / bounds.height) * source.height,
						),
					),
				};
			};
			this.canvas.addEventListener("pointerdown", (event) => {
				if (!event.isPrimary || event.button !== 0) return;
				this.start = point(event);
				this.canvas.setPointerCapture(event.pointerId);
			});
			this.canvas.addEventListener("pointermove", (event) => {
				if (!this.start || !event.isPrimary) return;
				const end = point(event);
				this.region = DocumentOcr.clampRegion(
					{
						left: Math.min(this.start.x, end.x),
						top: Math.min(this.start.y, end.y),
						width: Math.max(1, Math.abs(end.x - this.start.x)),
						height: Math.max(1, Math.abs(end.y - this.start.y)),
						scalePercent: 1,
					},
					source.width,
					source.height,
				);
				this.draw();
			});
			const stop = () => {
				this.start = null;
			};
			this.canvas.addEventListener("pointerup", stop);
			this.canvas.addEventListener("pointercancel", stop);
			this.panel
				.querySelector('[data-action="read"]')
				.addEventListener("click", () => {
					if (this.region.width < 8 || this.region.height < 8) return;
					onConfirm({ ...this.region });
				});
			this.panel
				.querySelector('[data-action="retake"]')
				.addEventListener("click", onRetake);
			this.panel
				.querySelector('[data-action="cancel"]')
				.addEventListener("click", onCancel);
			this.draw();
			(<HTMLElement>this.panel.querySelector("h2")).focus();
		}

		private draw() {
			const r = this.region,
				scale = this.canvas.width / this.source.width;
			const ctx = this.canvas.getContext("2d");
			ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
			ctx.drawImage(this.source, 0, 0, this.canvas.width, this.canvas.height);
			ctx.fillStyle = "rgba(6,20,30,.55)";
			ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
			ctx.drawImage(
				this.source,
				r.left,
				r.top,
				r.width,
				r.height,
				r.left * scale,
				r.top * scale,
				r.width * scale,
				r.height * scale,
			);
			ctx.strokeStyle = "#5bffc9";
			ctx.lineWidth = 3;
			ctx.strokeRect(
				r.left * scale,
				r.top * scale,
				r.width * scale,
				r.height * scale,
			);
			const previewScale = Math.min(4, 600 / r.width, 160 / r.height);
			this.preview.width = Math.max(1, Math.round(r.width * previewScale));
			this.preview.height = Math.max(1, Math.round(r.height * previewScale));
			this.preview
				.getContext("2d")
				.drawImage(
					this.source,
					r.left,
					r.top,
					r.width,
					r.height,
					0,
					0,
					this.preview.width,
					this.preview.height,
				);
			this.panel
				.querySelectorAll<HTMLInputElement>("input")
				.forEach((input) => {
					const field = input.getAttribute("data-field");
					input.value = String(
						((<any>r)[field] /
							(field === "left" || field === "width"
								? this.source.width
								: this.source.height)) *
							100,
					);
				});
			(<HTMLButtonElement>(
				this.panel.querySelector('[data-action="read"]')
			)).disabled = r.width < 8 || r.height < 8;
		}

		public destroy() {
			this.canvas.width = 0;
			this.preview.width = 0;
			this.panel.remove();
			this.source = null;
			this.start = null;
		}
	}
}
