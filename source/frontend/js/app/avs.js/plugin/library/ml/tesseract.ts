namespace Avs {
	export namespace Plugin {
		export namespace Library {
			export namespace Ml {
				export class Tesseract extends Avs.Plugin.Handler {
					static readonly LANGUAGE_EN = "eng";
					static readonly LANGUAGE_FR = "fra";

					static readonly MONTH_NAME_LANGUAGE_FR = "fr";
					static readonly MONTH_NAME_LANGUAGE_EN = "en";
					static readonly MONTH_NAME_LANGUAGE_BE = "be";
					static readonly MONTH_NAME_LANGUAGE_EL = "el";
					static readonly MONTH_NAME_LANGUAGE_NL = "nl";

					public config: ITesseractConfig;
					public event: Avs.Event.Listener;
					public api: Avs.IGenericApi;

					private monthNameLanguage: string;
					private monthNameList: IMonthNameList;

					public tesseractClass: any;
					public workerInstance: any;

					public workerLoaded: boolean;
					public languageLoaded: boolean;
					public languageInit: boolean;
					public workerConfigured: boolean;

					public videoElement: HTMLVideoElement;
					public lastFailure: string = null;
					private activeFailure: (error: any) => void = null;
					private progressStatus = "";
					private progressBucket = -1;

					constructor(
						config: ITesseractConfig,
						event: Avs.Event.Listener,
						api: Avs.IGenericApi,
					) {
						super(config, event, api);

						this.config = config;
						this.api = api;

						this.monthNameLanguage = Tesseract.MONTH_NAME_LANGUAGE_FR;
						this.monthNameList = {
							[Tesseract.MONTH_NAME_LANGUAGE_FR]: {
								"01": "janv",
								"02": "févr",
								"03": "mars",
								"04": "avril",
								"05": "mai",
								"06": "juin",
								"07": "juil",
								"08": "août",
								"09": "sept",
								"10": "oct",
								"11": "nov",
								"12": "déc",
							},
							[Tesseract.MONTH_NAME_LANGUAGE_EN]: {
								"01": "jan",
								"02": "feb",
								"03": "mar",
								"04": "apr",
								"05": "may",
								"06": "jun",
								"07": "jul",
								"08": "aug",
								"09": "sept",
								"10": "oct",
								"11": "nov",
								"12": "dec",
							},
							[Tesseract.MONTH_NAME_LANGUAGE_BE]: {
								"01": "jan",
								"02": "feb",
								"03": "maart",
								"04": "apr",
								"05": "mei",
								"06": "juni",
								"07": "juli",
								"08": "aug",
								"09": "sept",
								"10": "oct",
								"11": "nov",
								"12": "dec",
							},
							[Tesseract.MONTH_NAME_LANGUAGE_NL]: {
								"01": "jan",
								"02": "feb",
								"03": "maart",
								"04": "apr",
								"05": "mei",
								"06": "juni",
								"07": "juli",
								"08": "aug",
								"09": "sept",
								"10": "oct",
								"11": "nov",
								"12": "dec",
							},
							[Tesseract.MONTH_NAME_LANGUAGE_EL]: {
								"01": "ian",
								"02": "phevr",
								"03": "mart",
								"04": "apr",
								"05": "maios",
								"06": "ioun",
								"07": "ioul",
								"08": "aug",
								"09": "sept",
								"10": "okt",
								"11": "noem",
								"12": "dek",
							},
						};

						Avs.Debug.DocumentDiagnostics.install();
						Avs.Debug.DocumentDiagnostics.emit("worker-create", "start");
						this.tesseractClass = window.Tesseract;
						if (
							!this.tesseractClass ||
							typeof this.tesseractClass.createWorker !== "function"
						) {
							this.lastFailure = "LIBRARY_MISSING";
							Avs.Debug.DocumentDiagnostics.emit(
								"worker-create",
								"failure",
								{},
								this.lastFailure,
							);
						} else {
							try {
								this.workerInstance = this.tesseractClass.createWorker({
									workerPath: this.config.workerPath,
									langPath: this.config.languagePath,
									corePath: this.config.corePath,
									cacheMethod: "refresh",
									logger: (result: any) => this.logProgress(result),
									errorHandler: (error: any) => {
										if (this.activeFailure) this.activeFailure(error);
									},
								});
								// Tesseract 2 does not forward native Worker errors through errorHandler.
								if (this.workerInstance.worker) {
									this.workerInstance.worker.addEventListener(
										"error",
										(event: ErrorEvent) => {
											event.preventDefault();
											if (this.activeFailure) this.activeFailure(event);
											else {
												this.lastFailure =
													Avs.Debug.DocumentDiagnostics.errorCode(event);
												Avs.Debug.DocumentDiagnostics.emit(
													"worker-create",
													"failure",
													{},
													this.lastFailure,
												);
											}
										},
									);
								}
								Avs.Debug.DocumentDiagnostics.emit("worker-create", "success");
							} catch (error) {
								this.lastFailure =
									Avs.Debug.DocumentDiagnostics.errorCode(error);
								Avs.Debug.DocumentDiagnostics.emit(
									"worker-create",
									"failure",
									{},
									this.lastFailure,
								);
							}
						}

						this.videoElement = <HTMLVideoElement>(
							$(this.config.videoElementSelector).get(0)
						);

						this.workerLoaded = false;
						this.languageLoaded = false;
						this.languageInit = false;
						this.workerConfigured = false;
					}

					public setIdConfig(
						idConfig: Avs.Entity.IIdTypeToConfigItem,
						cb: Function,
						pageSegmentation: number = 6,
					) {
						this.config.idConfig = idConfig;
						this.configureWorker((result: boolean | null) => {
							cb(result);
						}, pageSegmentation);
					}

					public isValidLanguage(language: string) {
						return (
							language == Tesseract.LANGUAGE_EN ||
							language == Tesseract.LANGUAGE_FR
						);
					}

					private logProgress(result: any) {
						const stages: { [key: string]: string } = {
							"loading tesseract core": "worker-load",
							"initializing tesseract": "worker-load",
							"loading language traineddata": "language-load",
							"initializing api": "language-init",
							"recognizing text": "ocr-recognize",
						};
						const stage = result && stages[result.status];
						if (
							!stage ||
							typeof result.progress !== "number" ||
							!isFinite(result.progress)
						)
							return;
						const bucket =
							Math.floor(Math.max(0, Math.min(1, result.progress)) * 10) * 10;
						if (
							result.status === this.progressStatus &&
							bucket === this.progressBucket
						)
							return;
						this.progressStatus = result.status;
						this.progressBucket = bucket;
						Avs.Debug.DocumentDiagnostics.emit(stage, "progress", {
							progressPercent: bucket,
						});
					}

					private fail(stage: string, code: string, cb: Function) {
						this.lastFailure = code;
						Avs.Debug.DocumentDiagnostics.emit(stage, "failure", {}, code);
						cb(null);
					}

					private runStage(
						stage: string,
						operation: () => Promise<any>,
						cb: Function,
						details: { [key: string]: any } = {},
					) {
						const started = Date.now();
						let finished = false;
						this.lastFailure = null;
						this.progressStatus = "";
						this.progressBucket = -1;
						Avs.Debug.DocumentDiagnostics.emit(stage, "start", details);
						const finish = (success: boolean, value: any, code?: string) => {
							if (finished) return;
							finished = true;
							clearTimeout(timer);
							this.activeFailure = null;
							if (!success) this.lastFailure = code;
							Avs.Debug.DocumentDiagnostics.emit(
								stage,
								success ? "success" : "failure",
								{ ...details, elapsedMs: Date.now() - started },
								code,
							);
							cb(success ? value : null);
						};
						const timer = setTimeout(() => {
							// A stuck worker cannot safely accept another job.
							this.workerConfigured = false;
							try {
								this.workerInstance.terminate();
							} catch (error) {
								/* Report the original timeout. */
							}
							finish(false, null, "TIMEOUT");
						}, 90000);
						this.activeFailure = (error: any) =>
							finish(
								false,
								null,
								Avs.Debug.DocumentDiagnostics.errorCode(error),
							);
						let promise: Promise<any>;
						try {
							promise = operation();
						} catch (error) {
							this.activeFailure(error);
							return;
						}
						Promise.resolve(promise).then(
							(value: any) => finish(true, value),
							(error: any) =>
								finish(
									false,
									null,
									Avs.Debug.DocumentDiagnostics.errorCode(error),
								),
						);
					}

					public loadWorker(cb: Function) {
						if (!this.workerInstance || this.lastFailure) {
							this.fail("worker-load", this.lastFailure || "NOT_READY", cb);
							return;
						}
						this.runStage(
							"worker-load",
							() => this.workerInstance.load(),
							(result: any) => {
								this.workerLoaded = result !== null;
								cb(this.workerLoaded ? true : null);
							},
						);
					}

					public loadLanguage(language: string, cb: Function) {
						if (!this.workerLoaded) {
							this.fail("language-load", "NOT_READY", cb);
							return;
						}
						if (!this.isValidLanguage(language)) {
							this.fail("language-load", "INVALID_CONFIG", cb);
							return;
						}
						this.runStage(
							"language-load",
							() => this.workerInstance.loadLanguage(language),
							(result: any) => {
								this.languageLoaded = result !== null;
								cb(this.languageLoaded ? true : null);
							},
							{ language },
						);
					}

					public initLanguage(language: string, cb: Function) {
						if (!this.workerLoaded || !this.languageLoaded) {
							this.fail("language-init", "NOT_READY", cb);
							return;
						}
						if (!this.isValidLanguage(language)) {
							this.fail("language-init", "INVALID_CONFIG", cb);
							return;
						}
						this.runStage(
							"language-init",
							() => this.workerInstance.initialize(language),
							(result: any) => {
								this.languageInit = result !== null;
								cb(this.languageInit ? true : null);
							},
						);
					}

					public configureWorker(cb: Function, pageSegmentation: number = 6) {
						this.workerConfigured = false;
						if (
							!this.workerLoaded ||
							!this.languageLoaded ||
							!this.languageInit
						) {
							this.fail("worker-configure", "NOT_READY", cb);
							return;
						}
						if (
							!this.config.idConfig ||
							!this.config.idConfig.tesseractConfig
						) {
							this.fail("worker-configure", "INVALID_CONFIG", cb);
							return;
						}
						const selectedSegmentation =
							this.config.idConfig.tesseractConfig.tessedit_pageseg_mode !==
							undefined
								? this.config.idConfig.tesseractConfig.tessedit_pageseg_mode
								: pageSegmentation;
						this.runStage(
							"worker-configure",
							() =>
								this.workerInstance.setParameters({
									...this.config.idConfig.tesseractConfig,
									tessedit_pageseg_mode: selectedSegmentation,
								}),
							(result: any) => {
								this.workerConfigured = result !== null;
								cb(this.workerConfigured ? true : null);
							},
							{
								pageSegmentation: selectedSegmentation,
								layoutYear: this.config.idConfig.year,
							},
						);
					}

					public ocrImage(image: any, cb: Function) {
						if (
							!this.workerLoaded ||
							!this.languageLoaded ||
							!this.languageInit ||
							!this.workerConfigured
						) {
							this.fail("ocr-recognize", "NOT_READY", cb);
							return;
						}
						this.runStage(
							"ocr-recognize",
							() => this.workerInstance.recognize(image),
							cb,
						);
					}

					public extractInformationFromId(image: any, cb: Function) {
						this.ocrImage(image, (result: any) => {
							// Preserve the original failure instead of dereferencing result.data on null.
							if (result === null && this.lastFailure) {
								cb(null);
								return;
							}
							if (
								!result ||
								!result.data ||
								typeof result.data.text !== "string"
							) {
								this.fail("ocr-text", "INVALID_RESULT", cb);
								return;
							}
							let foundText = result.data.text.trim();
							if (this.config.idConfig.stripWhiteSpace)
								foundText = foundText.replace(/\s/g, "");
							Avs.Debug.DocumentDiagnostics.emit(
								"ocr-text",
								foundText ? "success" : "retry",
								{ characterCount: foundText.length },
								foundText ? undefined : "EMPTY_TEXT",
							);
							if (!foundText) {
								cb(null);
								return;
							}

							const config = this.config.idConfig;
							let match: RegExpExecArray = null;
							let ruleIndex = -1;
							Avs.Debug.DocumentDiagnostics.emit("date-match", "start", {
								ruleCount:
									config.textMatcherRule && config.textMatcherRule.length,
							});
							try {
								if (!config.textMatcherRule || !config.textMatcherRule.length)
									throw new Error("Invalid rules");
								for (let i = 0; i < config.textMatcherRule.length; i++) {
									const rule = config.textMatcherRule[i];
									const end = rule.lastIndexOf("/");
									if (rule[0] !== "/" || end < 1)
										throw new Error("Invalid rule");
									match = new RegExp(
										rule.slice(1, end),
										rule.slice(end + 1),
									).exec(foundText);
									if (match) {
										ruleIndex = i;
										break;
									}
								}
							} catch (error) {
								this.fail("date-match", "INVALID_CONFIG", cb);
								return;
							}
							if (!match) {
								Avs.Debug.DocumentDiagnostics.emit(
									"date-match",
									"retry",
									{ ruleCount: config.textMatcherRule.length },
									"NO_DATE_MATCH",
								);
								cb(null);
								return;
							}
							Avs.Debug.DocumentDiagnostics.emit("date-match", "success", {
								ruleIndex,
							});
							const positions =
								config.dateComponentsPosition &&
								config.dateComponentsPosition[ruleIndex];
							if (
								!positions ||
								typeof match[positions.day] !== "string" ||
								typeof match[positions.month] !== "string" ||
								typeof match[positions.year] !== "string"
							) {
								this.fail("date-parse", "INVALID_CONFIG", cb);
								return;
							}
							this.monthNameLanguage =
								config.monthNameLanguage || Tesseract.MONTH_NAME_LANGUAGE_FR;
							if (!this.monthNameList[this.monthNameLanguage]) {
								this.fail("date-parse", "INVALID_CONFIG", cb);
								return;
							}
							const day = this.formatDay(match[positions.day]);
							const month = this.formatMonth(match[positions.month]);
							const year = this.formatYear(match[positions.year]);
							const dateString = year + "-" + month + "-" + day;
							const date = new Date(dateString);
							const now = new Date();
							if (
								!/^\d{4}-\d{2}-\d{2}$/.test(dateString) ||
								!isFinite(date.getTime()) ||
								date.getUTCFullYear() !== Number(year) ||
								date.getUTCMonth() + 1 !== Number(month) ||
								date.getUTCDate() !== Number(day) ||
								date > now
							) {
								Avs.Debug.DocumentDiagnostics.emit(
									"date-parse",
									"retry",
									{ ruleIndex },
									"INVALID_DATE",
								);
								cb(null);
								return;
							}
							let age = now.getUTCFullYear() - date.getUTCFullYear();
							if (
								now.getUTCMonth() < date.getUTCMonth() ||
								(now.getUTCMonth() === date.getUTCMonth() &&
									now.getUTCDate() < date.getUTCDate())
							)
								age--;
							Avs.Debug.DocumentDiagnostics.emit("date-parse", "success", {
								ruleIndex,
							});
							cb({ birthDate: dateString, age });
						});
					}

					public formatDay(day: string): string {
						return day.length == 2 ? day : "0" + day;
					}

					public formatMonth(month: string): string {
						month = month.toLowerCase();

						for (let i in this.monthNameList[this.monthNameLanguage]) {
							month = month.replace(
								this.monthNameList[this.monthNameLanguage][i],
								i,
							);
							month = month.replace(
								this.monthNameList[this.monthNameLanguage][i].toUpperCase(),
								i,
							);
						}

						return month.length == 2 ? month : "0" + month;
					}

					public formatYear(year: string) {
						if (year.length == 4) {
							return year;
						}

						if (year.length == 2) {
							let currentYear = new Date().getFullYear().toString().substr(-2);

							if (year <= currentYear) {
								year = "20" + year;
								return year;
							}

							year = "19" + year;
							return year;
						}

						return 0;
					}
				}

				export interface ITesseractConfig {
					idConfig: Avs.Entity.IIdTypeToConfigItem;
					workerPath: string;
					languagePath: string;
					corePath: string;
					videoElementSelector: string;
					debugLevel?: number;
				}

				export interface IMonthNameList {
					[key: string]: {
						[key: string]: string;
					};
				}
			}
		}
	}
}
