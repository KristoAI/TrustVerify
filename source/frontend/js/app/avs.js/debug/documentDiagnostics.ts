namespace Avs.Debug {
	/** Console-only diagnostics. Never pass document content, identity data, or raw errors here. */
	export class DocumentDiagnostics {
		private static run = 0;
		private static listening = false;
		private static context: {
			attempt?: number;
			variant?: number;
			profile?: number;
		} = {};
		private static report: string[] = [];
		private static retryCounts: { [key: string]: number } = {};

		public static setAttempt(
			attempt: number,
			variant: number,
			profile: number,
		) {
			this.context = { attempt, variant, profile };
		}

		/** Sanitized in-memory copy for support; never stored or uploaded. */
		public static getReport(): string {
			return this.report.join("\n");
		}
		private static readonly stages = [
			"asset-preload",
			"document-image",
			"worker-create",
			"worker-load",
			"language-load",
			"language-init",
			"worker-configure",
			"ocr-recognize",
			"ocr-text",
			"date-match",
			"date-parse",
			"face-detect-model",
			"face-recognition-model",
			"face-landmarks-model",
			"face-extract",
			"face-compare",
			"image-crop",
			"image-preprocess",
			"document-result",
			"security-policy",
		];
		private static readonly hints: { [key: string]: string } = {
			CROP_REVIEW:
				"Reading paused for local crop review. No verification result has been granted.",
			CROP_SELECTED:
				"User selected a local image region. OCR and age checks must still succeed.",

			LIBRARY_MISSING:
				"The Tesseract browser library did not load. Check its script in Network.",
			WORKER_ERROR:
				"The document worker failed. Check the preceding stage and asset requests in Network.",
			NETWORK_ERROR:
				"An OCR asset could not be fetched. Check worker, core and traineddata requests in Network.",
			CSP_BLOCKED:
				"Browser security policy blocked OCR. Check the browser CSP violation and worker/core requests.",
			TIMEOUT:
				"This stage exceeded 90 seconds. Check asset requests, worker errors and available memory.",
			NOT_READY: "A required OCR initialization stage has not succeeded.",
			INVALID_CONFIG:
				"The selected document layout has invalid OCR parameters or date matcher configuration.",
			INVALID_RESULT: "The OCR worker returned no usable text result.",
			EMPTY_TEXT:
				"OCR finished but read no text. Check image quality and whether the date crop covers the correct area.",
			NO_DATE_MATCH:
				"OCR read text, but no configured date pattern matched. Check document type, layout variant and crop.",
			INVALID_DATE:
				"A pattern matched but its captures do not form a valid calendar date.",
			INVALID_IMAGE:
				"The document image or crop has invalid dimensions or lies outside the source image.",
			CROP_CLIPPED:
				"Part of the expected date region lies outside the image. OCR will still try the visible portion; check framing and document layout.",
			IMAGE_ERROR:
				"Image preparation failed. Check canvas availability and image decoding.",
			NO_FACE:
				"No document face was found in this attempt; text extraction has not started.",
			MODEL_ERROR:
				"A face model could not load. Check model requests in Network.",
			VERIFICATION_FAILED:
				"Document verification ended. The numeric failureCode identifies the application outcome.",
		};

		public static begin() {
			this.run++;
			this.context = {};
			this.report = [];
			this.retryCounts = {};
			this.install();
		}

		public static install() {
			if (this.listening) return;
			this.listening = true;
			window.addEventListener(
				"securitypolicyviolation",
				(event: SecurityPolicyViolationEvent) => {
					if (
						/^(script-src|worker-src|connect-src)/.test(
							event.effectiveDirective,
						)
					) {
						// Do not print blockedURI/sourceFile: they can contain tokens or document data.
						this.emit("security-policy", "failure", {}, "CSP_BLOCKED");
					}
				},
			);
		}

		public static errorCode(error: any): string {
			// Inspect locally, but NEVER forward the original error/message/stack to the console.
			const message =
				typeof error === "string"
					? error
					: error && typeof error.message === "string"
						? error.message
						: "";
			if (/content security|unsafe-eval|refused to|\bcsp\b/i.test(message))
				return "CSP_BLOCKED";
			if (/fetch|network|importscripts|failed to load|404|403/i.test(message))
				return "NETWORK_ERROR";
			return "WORKER_ERROR";
		}

		public static emit(
			stage: string,
			status: "start" | "progress" | "success" | "retry" | "failure",
			details: { [key: string]: any } = {},
			code?: string,
		) {
			if (
				this.stages.indexOf(stage) < 0 ||
				["start", "progress", "success", "retry", "failure"].indexOf(status) < 0
			)
				return;
			const safe: { [key: string]: any } = { run: this.run, stage, status };
			details = { ...this.context, ...details };
			// Runtime allowlist, so even accidental extra fields cannot expose extracted text or biometrics.
			for (const key of [
				"attempt",
				"variant",
				"profile",
				"pageSegmentation",
				"layoutYear",
				"width",
				"height",
				"elapsedMs",
				"progressPercent",
				"characterCount",
				"ruleCount",
				"ruleIndex",
				"failureCode",
				"httpStatus",
			]) {
				if (typeof details[key] === "number" && isFinite(details[key]))
					safe[key] = Math.round(details[key]);
			}
			if (
				[
					"ocr-worker",
					"ocr-core",
					"ocr-language-eng",
					"ocr-language-fra",
				].indexOf(details.asset) >= 0
			)
				safe.asset = details.asset;
			if (code && Object.prototype.hasOwnProperty.call(this.hints, code)) {
				safe.code = code;
				safe.hint = this.hints[code];
			}
			if (details.cropMode === "automatic" || details.cropMode === "selected")
				safe.cropMode = details.cropMode;
			if (details.language === "eng" || details.language === "fra")
				safe.language = details.language;
			if (status === "retry" && code) {
				const key = stage + ":" + code;
				this.retryCounts[key] = (this.retryCounts[key] || 0) + 1;
				safe.occurrences = this.retryCounts[key];
			}
			if (stage === "document-result")
				safe.retryCounts = { ...this.retryCounts };
			// String snapshot prevents DevTools retaining mutable objects containing sensitive fields.
			const message = "[TrustBunny][document] " + JSON.stringify(safe);
			this.report.push(message);
			if (this.report.length > 1000) this.report.shift();
			if (status === "failure") console.error(message);
			// Expected retries are info, avoiding hundreds of DevTools async warning stacks.
			else console.info(message);
		}
	}
}
