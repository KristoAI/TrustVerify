namespace AvsFactory {
	export namespace ScanIdAgeVerificationPage {
		export class Method {
			private static manualCrop: Avs.Helper.IVideoMaskPosition = null;
			private static lastCrop: Avs.Helper.IVideoMaskPosition = null;
			private static cropReview: Avs.Helper.DocumentCropReview = null;
			private static reviewOpen = false;
			private static readingRoundStart = 0;

			public static init(): void {
				if (Method.cropReview) Method.cropReview.destroy();
				Method.cropReview = null;
				Method.reviewOpen = false;
				Method.manualCrop = null;
				Method.lastCrop = null;
				Method.readingRoundStart = 0;
				$("#documentProcessingCanvasContainer").show();
				if (
					instance.entity.ScanIdAgeVerification.facingMode !==
					Config.FACING_MODE_REQUIRED
				) {
					instance.plugin.Library.Video.CameraSource.getVideoElement().addClass(
						"mirrored",
					);
				}

				if (
					!instance.entity.VerificationStepGlobal
						.scanIdAgeVerificationInVideoBypassMode
				) {
					Method.initVideo();
				}
			}

			public static getProcessingCanvas() {
				return <HTMLCanvasElement>$(Config.DOCUMENT_PROCESSING_CANVAS).get(0);
			}

			public static getIdGuideContainer() {
				return <HTMLElement>$(Config.ID_CARD_GUIDE_CONTAINER).get(0);
			}

			public static updateScreenLight() {
				const toggle = <HTMLButtonElement>(
					document.getElementById("idScreenLightToggle")
				);
				const slider = <HTMLInputElement>(
					document.getElementById("idScreenLightIntensity")
				);
				const page = document.getElementById("scanIdAgeVerificationPage");
				const enabled = toggle.getAttribute("aria-pressed") === "true";
				const value = Math.round((255 * Number(slider.value)) / 100);
				page.style.setProperty(
					"--id-light-color",
					enabled
						? "rgb(" + value + "," + value + "," + value + ")"
						: "#172331",
				);
				page.setAttribute("data-screen-light", enabled ? "on" : "off");
				toggle.textContent = enabled ? "Screen light on" : "Screen light off";
				slider.disabled = !enabled;
			}

			public static initVideo() {
				instance.ui.ScanIdAgeVerificationTakePhotoButton.disable();
				Method.updateScreenLight();
				instance.ui.ScanIdAgeVerificationLoadingLabelArea.setContent(
					"Trying to access your camera",
				);

				instance.plugin.Library.Video.CameraSource.init();
				instance.plugin.Library.Video.CameraSource.showVideo();

				Method.repositionScanId();
			}

			public static loadDetectionLibrary() {
				Avs.Debug.DocumentDiagnostics.begin();
				const source = Method.getProcessingCanvas();
				if (!source || !source.width || !source.height) {
					Avs.Debug.DocumentDiagnostics.emit(
						"document-image",
						"failure",
						{},
						"INVALID_IMAGE",
					);
					Method.goToFailStep(
						25070,
						"The document image is not ready. Please capture or upload it again.",
					);
					return;
				}
				Avs.Debug.DocumentDiagnostics.emit("document-image", "success", {
					width: source.width,
					height: source.height,
				});

				instance.ui.ScanIdAgeVerificationLoadingLabelPercentCounter.setValue(0);

				instance.plugin.Library.Ml.Tesseract.loadWorker(
					(result: boolean | null) => {
						if (result === null) {
							StartPage.Method.renderError(
								25040,
								"Could not start the document reader. Reload and try again.",
							);
							return;
						}

						instance.ui.ScanIdAgeVerificationLoadingLabelPercentCounter.increment();

						instance.plugin.Library.Ml.Tesseract.loadLanguage(
							Config.TESSERACT_LANGUAGE,
							(result: boolean | null) => {
								if (result === null) {
									StartPage.Method.renderError(
										25041,
										"Could not load the document language files. Check your connection and try again.",
									);
									return;
								}

								instance.ui.ScanIdAgeVerificationLoadingLabelPercentCounter.increment();

								instance.plugin.Library.Ml.Tesseract.initLanguage(
									Config.TESSERACT_LANGUAGE,
									(result: boolean | null) => {
										if (result === null) {
											StartPage.Method.renderError(
												25042,
												"Could not initialize the document language reader.",
											);
											return;
										}

										instance.ui.ScanIdAgeVerificationLoadingLabelPercentCounter.increment();

										instance.plugin.Library.Ml.Tesseract.configureWorker(
											(result: boolean | null) => {
												if (result === null) {
													StartPage.Method.renderError(
														25043,
														"Could not configure the document reader for this document type.",
													);
													return;
												}

												instance.ui.ScanIdAgeVerificationLoadingLabelPercentCounter.increment();

												Avs.Debug.DocumentDiagnostics.emit(
													"face-detect-model",
													"start",
												);
												instance.plugin.Library.Ml.FaceApi.loadDetector(
													(result: boolean | null) => {
														Avs.Debug.DocumentDiagnostics.emit(
															"face-detect-model",
															result === null ? "failure" : "success",
															{},
															result === null ? "MODEL_ERROR" : undefined,
														);

														if (result === null) {
															StartPage.Method.renderError(
																25044,
																"Failed to initialize detection libraries",
															);
															return;
														}

														instance.ui.ScanIdAgeVerificationLoadingLabelPercentCounter.increment();

														Avs.Debug.DocumentDiagnostics.emit(
															"face-recognition-model",
															"start",
														);
														instance.plugin.Library.Ml.FaceApi.loadFaceRecognitionModel(
															(result: boolean | null) => {
																Avs.Debug.DocumentDiagnostics.emit(
																	"face-recognition-model",
																	result === null ? "failure" : "success",
																	{},
																	result === null ? "MODEL_ERROR" : undefined,
																);

																if (result === null) {
																	StartPage.Method.renderError(
																		25045,
																		"Failed to initialize detection libraries",
																	);
																	return;
																}

																instance.ui.ScanIdAgeVerificationLoadingLabelPercentCounter.increment();

																Avs.Debug.DocumentDiagnostics.emit(
																	"face-landmarks-model",
																	"start",
																);
																instance.plugin.Library.Ml.FaceApi.loadLandmarksModel(
																	(result: boolean | null) => {
																		Avs.Debug.DocumentDiagnostics.emit(
																			"face-landmarks-model",
																			result === null ? "failure" : "success",
																			{},
																			result === null
																				? "MODEL_ERROR"
																				: undefined,
																		);

																		if (result === null) {
																			StartPage.Method.renderError(
																				25063,
																				"Failed to initialize detection libraries",
																			);
																			return;
																		}

																		instance.ui.ScanIdAgeVerificationLoadingLabelPercentCounter.increment();
																		instance.ui.ScanIdAgeVerificationLoadingLibraryButton.hideLoading();

																		Method.faceExtractionStart();
																	},
																);
															},
														);
													},
												);
											},
										);
									},
								);
							},
						);
					},
				);
			}

			public static faceExtractionStart() {
				Method.extractFace();
			}

			public static extractFace() {
				Avs.Debug.DocumentDiagnostics.emit("face-extract", "start", {
					attempt: instance.entity.ScanIdAgeVerification.totalFaceNumber + 1,
				});

				let processingCanvas = Method.getProcessingCanvas();

				instance.plugin.Library.Ml.FaceApi.detectFaceFromCustomElement(
					processingCanvas,
					(faceResult: any) => {
						instance.entity.ScanIdAgeVerification.totalFaceNumber++;
						Avs.Debug.DocumentDiagnostics.emit(
							"face-extract",
							faceResult === null ? "retry" : "success",
							{
								attempt: instance.entity.ScanIdAgeVerification.totalFaceNumber,
							},
							faceResult === null ? "NO_FACE" : undefined,
						);

						if (faceResult !== null) {
							instance.entity.ScanIdAgeVerification.validFaceNumber++;

							instance.plugin.Library.Ml.FaceApi.extractFaceImageFromCustomElement(
								faceResult.detection,
								processingCanvas,
								(canvasFace: any) => {
									instance.entity.ScanIdAgeVerification.validFaceList.push(
										faceResult,
									);
									instance.entity.ScanIdAgeVerification.validCanvasFaceList.push(
										canvasFace[0],
									);

									Method.checkExtractFaceStep();
								},
							);
						} else {
							let adjustment =
								Method.getBrightnessAndContrastRandomAdjustment();

							Avs.Helper.Canvas.contrastCanvas(
								Method.getProcessingCanvas(),
								adjustment.contrast,
							);
							Avs.Helper.Canvas.brightnessCanvas(
								Method.getProcessingCanvas(),
								adjustment.brightness,
							);

							Method.checkExtractFaceStep();
						}
					},
				);
			}

			public static getBrightnessAndContrastRandomAdjustment() {
				let negativeBrightnessOperation = Math.random() >= 0.5;
				let negativeContrastOperation = Math.random() >= 0.5;
				let brightnessAdjustment =
					Math.floor(Math.random() * Config.BRIGHTNESS_ADJUSTMENT_MAX_VALUE) +
					1;
				let contrastAdjustment =
					Math.floor(Math.random() * Config.CONTRAST_ADJUSTMENT_MAX_VALUE) + 1;

				let brightness =
					instance.entity.ScanIdAgeVerification.getIdTypeConfig().brightness;
				if (negativeBrightnessOperation) {
					brightness -= brightnessAdjustment;
				} else {
					brightness += brightnessAdjustment;
				}

				let contrast =
					instance.entity.ScanIdAgeVerification.getIdTypeConfig().contrast;
				if (negativeContrastOperation) {
					contrast -= contrastAdjustment;
				} else {
					contrast += contrastAdjustment;
				}

				return {
					brightness: brightness,
					contrast: contrast,
				};
			}

			public static isScanIdVerificationStandalone() {
				return (
					instance.entity.VerificationStepGlobal.verificationType ===
					Avs.Entity.VerificationStepGlobal.VERIFICATION_TYPE_SCAN_ID
				);
			}

			public static checkExtractFaceStep() {
				if (
					instance.entity.ScanIdAgeVerification.validFaceNumber ==
					Config.MAX_VALID_FACE_SCAN_NUMBER
				) {
					if (Method.isScanIdVerificationStandalone()) {
						Method.ocrImage();
					} else {
						Method.compareFaceDescriptors();
					}

					return;
				}

				if (
					instance.entity.ScanIdAgeVerification.totalFaceNumber ==
					Config.MAX_TOTAL_FACE_SCAN_NUMBER
				) {
					Method.goToFailStep(
						25051,
						"Failed to extract a face from your identity card",
					);
					return;
				}

				setTimeout(() => {
					Method.extractFace();
				}, Config.FACE_SCAN_INTERVAL_MS);
			}

			public static compareFaceDescriptors() {
				Avs.Debug.DocumentDiagnostics.emit("face-compare", "start");

				for (
					let i = 0,
						j = instance.entity.SelfieAgeDetection.validCanvasFaceList.length;
					i < j;
					i++
				) {
					for (
						let ii = 0,
							jj = instance.entity.ScanIdAgeVerification.validFaceList.length;
						ii < jj;
						ii++
					) {
						let distance =
							instance.plugin.Library.Ml.FaceApi.compareFaceDescriptors(
								instance.entity.SelfieAgeDetection.validFaceList[i].descriptor,
								instance.entity.ScanIdAgeVerification.validFaceList[ii]
									.descriptor,
							);

						let faceItsMatching = distance <= Config.MAX_FACE_DISTANCE_TO_MATCH;
						if (faceItsMatching) {
							instance.entity.ScanIdAgeVerification.totalValidFaceMatch++;
						}

						if (
							instance.entity.ScanIdAgeVerification.totalValidFaceMatch >=
							Config.MIN_VALID_FACE_MATCH
						) {
							Avs.Debug.DocumentDiagnostics.emit("face-compare", "success");
							instance.ui.ScanIdAgeVerificationFaceSimilarityButton.hideLoading();

							Method.ocrImage();

							return;
						}
					}
				}

				Method.goToFailStep(
					25052,
					"Selfie face does not match the one found on the identity card",
				);
			}

			public static ocrImage() {
				if (Method.reviewOpen) return;
				// Test each variant with original pixels first, then repeatable enhancement profiles.
				const scan = instance.entity.ScanIdAgeVerification;
				if (scan.totalScanNumber > 0) scan.incrementIdVariantCurrent();
				const settings = Avs.Helper.DocumentOcr.attempt(
					scan.totalScanNumber - Method.readingRoundStart,
					scan.getIdVariantCount(),
				);
				Avs.Debug.DocumentDiagnostics.setAttempt(
					scan.totalScanNumber + 1,
					scan.idVariantCurrent,
					settings.profile,
				);

				instance.plugin.Library.Ml.Tesseract.setIdConfig(
					instance.entity.ScanIdAgeVerification.getIdTypeConfig(),
					(workerWasConfigured: boolean | null) => {
						if (!workerWasConfigured) {
							Method.goToFailStep(
								25071,
								"The document reader could not be configured. Please try again.",
							);
							return;
						}
						const details = {
							attempt:
								instance.entity.ScanIdAgeVerification.totalScanNumber + 1,
							variant: instance.entity.ScanIdAgeVerification.idVariantCurrent,
							cropMode: Method.manualCrop ? "selected" : "automatic",
						};
						Avs.Debug.DocumentDiagnostics.emit("image-crop", "start", details);
						let maskCanvas: HTMLCanvasElement;
						let adjustment: { brightness: number; contrast: number };
						let preparationStage = "image-crop";
						try {
							const idConfig =
								instance.entity.ScanIdAgeVerification.getIdTypeConfig();
							const faceCoordinates =
								instance.plugin.Library.Ml.FaceApi.extractFaceCoordinates(
									instance.entity.ScanIdAgeVerification.validFaceList[0],
								);
							const position =
								Method.manualCrop ||
								Avs.Helper.ElementPositionCalculator.calculateBirthDateMaskPosition(
									faceCoordinates,
									idConfig.idSizeList,
									settings.scaleAdjustment,
								);
							Method.lastCrop = { ...position };
							const source = Method.getProcessingCanvas();
							const zoom = Math.max(2, idConfig.idRegionZoom);
							if (
								![
									position.width,
									position.height,
									position.top,
									position.left,
									zoom,
								].every((value) => isFinite(value)) ||
								position.width <= 0 ||
								position.height <= 0 ||
								zoom <= 0 ||
								position.left >= source.width ||
								position.top >= source.height ||
								position.left + position.width <= 0 ||
								position.top + position.height <= 0
							) {
								Avs.Debug.DocumentDiagnostics.emit(
									"image-crop",
									"retry",
									details,
									"INVALID_IMAGE",
								);
								instance.entity.ScanIdAgeVerification.totalScanNumber++;
								Method.checkOcrStep();
								return;
							}
							if (
								position.left < 0 ||
								position.top < 0 ||
								position.left + position.width > source.width ||
								position.top + position.height > source.height
							) {
								Avs.Debug.DocumentDiagnostics.emit(
									"image-crop",
									"retry",
									details,
									"CROP_CLIPPED",
								);
							}
							maskCanvas = Avs.Helper.VideoAreaExtractor.videoMaskToCanvas(
								source,
								$(Config.CAMERA_SOURCE_CANVAS_RESULT_ELEMENT).get(0),
								position,
								zoom,
							);
							if (!maskCanvas.width || !maskCanvas.height)
								throw new Error("Empty canvas");
							Avs.Debug.DocumentDiagnostics.emit("image-crop", "success", {
								attempt: details.attempt,
								variant: details.variant,
								width: maskCanvas.width,
								height: maskCanvas.height,
							});
							preparationStage = "image-preprocess";
							Avs.Debug.DocumentDiagnostics.emit(
								preparationStage,
								"start",
								details,
							);
							if (settings.grayscale)
								Avs.Helper.Canvas.grayscaleCanvas(maskCanvas);
							adjustment = {
								brightness: settings.brightness,
								contrast: settings.contrast,
							};
							Avs.Helper.Canvas.brightnessCanvas(
								maskCanvas,
								adjustment.brightness,
							);
							Avs.Helper.Canvas.contrastCanvas(maskCanvas, adjustment.contrast);
							Avs.Debug.DocumentDiagnostics.emit(
								preparationStage,
								"success",
								details,
							);
						} catch (error) {
							Avs.Debug.DocumentDiagnostics.emit(
								preparationStage,
								"failure",
								details,
								"IMAGE_ERROR",
							);
							Method.goToFailStep(
								25072,
								"Could not prepare the document image. Please capture or upload it again.",
							);
							return;
						}

						instance.plugin.Library.Ml.Tesseract.extractInformationFromId(
							maskCanvas,
							(result: any) => {
								if (instance.plugin.Library.Ml.Tesseract.lastFailure) {
									Method.goToFailStep(
										25073,
										"The document text reader failed. Please reload and try again.",
									);
									return;
								}

								instance.entity.ScanIdAgeVerification.totalScanNumber++;

								if (
									result !== null &&
									result.age > 0 &&
									result.age < Config.MAX_SCAN_VALUE
								) {
									instance.ui.ScanIdAgeVerificationStatusLabel.stopBlinking();

									instance.entity.ScanIdAgeVerification.validScanNumber++;

									instance.ui.ScanIdAgeVerificationCurrentAgeArea.setContent(
										"Current detected age: " + result.age,
									);

									instance.entity.ScanIdAgeVerification.validScanValueList.push(
										result.age,
									);
									instance.entity.ScanIdAgeVerification.setLowestScanValue();

									// store working combination for reuse
									instance.entity.ScanIdAgeVerification.workingBrightnessValue =
										adjustment.brightness;
									instance.entity.ScanIdAgeVerification.workingContrastValue =
										adjustment.contrast;
								} else {
									instance.ui.ScanIdAgeVerificationStatusLabel.startBlinking();
								}

								Method.checkOcrStep();
							},
						);
					},
					settings.pageSegmentation,
				);
			}

			public static getAgeMinimumValue() {
				return Number((<any>Application).requiredAge || 18);
			}

			public static checkOcrStep() {
				if (
					instance.entity.ScanIdAgeVerification.validScanNumber ==
					Config.MAX_VALID_DATA_EXTRACTION_NUMBER
				) {
					if (
						instance.entity.ScanIdAgeVerification.lowestScanValue <
						Method.getAgeMinimumValue()
					) {
						Method.goToFailStep(
							25053,
							"Detected your age is lower than " +
								Method.getAgeMinimumValue() +
								" years",
						);
						return;
					}

					instance.entity.VerificationStepGlobal.verificationComplete = true;
					Method.goToSuccessStep();

					return;
				}

				if (
					instance.entity.ScanIdAgeVerification.totalScanNumber -
						Method.readingRoundStart >=
					Math.min(
						Config.MAX_TOTAL_DATA_EXTRACTION_NUMBER,
						instance.entity.ScanIdAgeVerification.getIdVariantCount() * 4,
					)
				) {
					Method.showCropReview();
					return;
				}

				setTimeout(() => {
					Method.ocrImage();
				}, Config.DATA_EXTRACTION_INTERVAL_MS);
			}

			public static showCropReview() {
				if (Method.reviewOpen) return;
				Method.reviewOpen = true;
				const source = Method.getProcessingCanvas();
				Avs.Debug.DocumentDiagnostics.emit(
					"image-crop",
					"retry",
					{ cropMode: Method.manualCrop ? "selected" : "automatic" },
					"CROP_REVIEW",
				);
				instance.ui.ScanIdAgeVerificationStatusLabel.stopBlinking();
				instance.ui.DocumentProcessingCanvasLoadingOverlayArea.hide();
				instance.ui.ScanIdAgeVerificationDocumentProcessingProcessArea.hide();
				$("#documentProcessingCanvasContainer").hide();
				Method.cropReview = new Avs.Helper.DocumentCropReview(
					document.getElementById(
						"scanIdAgeVerificationDocumentProcessingArea",
					),
					source,
					Method.lastCrop,
					(region) => {
						Method.manualCrop = region;
						Method.readingRoundStart =
							instance.entity.ScanIdAgeVerification.totalScanNumber;
						Method.closeCropReview();
						instance.ui.ScanIdAgeVerificationDocumentProcessingProcessArea.show();
						instance.ui.DocumentProcessingCanvasLoadingOverlayArea.show();
						Avs.Debug.DocumentDiagnostics.emit(
							"image-crop",
							"success",
							{ cropMode: "selected" },
							"CROP_SELECTED",
						);
						Method.ocrImage();
					},
					() => {
						Method.closeCropReview();
						window.location.reload();
					},
					() => {
						Method.goToFailStep(
							25054,
							"Verification cancelled because the birth date could not be read.",
						);
					},
				);
			}

			private static closeCropReview() {
				if (Method.cropReview) Method.cropReview.destroy();
				Method.cropReview = null;
				Method.reviewOpen = false;
				$("#documentProcessingCanvasContainer").show();
			}

			public static goToSuccessStep() {
				Method.closeCropReview();
				Avs.Debug.DocumentDiagnostics.emit("document-result", "success", {
					attempt: instance.entity.ScanIdAgeVerification.totalScanNumber,
				});
				StartPage.Method.showPageStep(
					StartPage.Config.RESULT_PAGE_SUCCESS_LAYER,
				);
				ResultPageSuccess.init();

				if (
					!instance.entity.VerificationStepGlobal
						.scanIdAgeVerificationInVideoBypassMode
				) {
					instance.plugin.Library.Video.CameraSource.datachannels.webrtc.stopStreaming();
				}
			}

			public static goToFailStep(failCode: number, failReason: string) {
				Method.closeCropReview();
				Avs.Debug.DocumentDiagnostics.emit(
					"document-result",
					"failure",
					{
						failureCode: failCode,
						attempt: instance.entity.ScanIdAgeVerification.totalScanNumber,
					},
					"VERIFICATION_FAILED",
				);
				StartPage.Method.showPageStep(StartPage.Config.RESULT_PAGE_FAIL_LAYER);

				ResultPageFail.init();
				ResultPageFail.Method.saveError(failCode);
				ResultPageFail.Method.renderFailReason(failCode + ": " + failReason);

				if (
					!instance.entity.VerificationStepGlobal
						.scanIdAgeVerificationInVideoBypassMode
				) {
					instance.plugin.Library.Video.CameraSource.datachannels.webrtc.stopStreaming();
				}
			}

			public static repositionScanId() {
				if (
					instance.entity.VerificationStepGlobal
						.scanIdAgeVerificationInVideoBypassMode
				) {
					return;
				}

				const container =
					instance.entity.ScanIdAgeVerification.getIdTypeConfig().idSizeList
						.container;
				const ratio = container.width / container.height;
				const previewWidth = Math.min(
					window.innerWidth * 0.68,
					380,
					window.innerHeight * 0.38 * ratio,
				);
				$("#scanIdAgeVerificationPage .tv-id-camera-stage").css({
					width: previewWidth,
					height: previewWidth / ratio,
				});
				// The guide is positioned inside the preview; screen offsets are mapped to camera pixels at capture time.
				$(Config.ID_CARD_GUIDE_CONTAINER).removeAttr("style");
				$(Config.ID_CARD_GUIDE_BIRTH_DATE_CONTAINER).hide();
			}
		}
	}
}
