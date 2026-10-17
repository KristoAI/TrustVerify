namespace Avs {

	export namespace Debug {

		/**
		 * Logger class activated based on a specified debug level
		 *
		 */
		export class Log {

			static readonly LOG_LEVEL_ERROR = 1;
			static readonly LOG_LEVEL_WARN  = 2;
			static readonly LOG_LEVEL_INFO  = 4;

			static readonly CONTAINER_SELECTOR = '#debugArea';

			private debugLevel: number;


			constructor(debugLevel?: number) {

				this.debugLevel = Log.LOG_LEVEL_ERROR;


				if (debugLevel) {
					this.debugLevel = debugLevel;
				}

			}

			public error(...params: Array<any>): void {

				if (this.debugLevel >= Log.LOG_LEVEL_ERROR) {
					// Verification content must not be logged.
				}

			}

			public warn(...params: Array<any>): void {

				if (this.debugLevel >= Log.LOG_LEVEL_WARN) {
					// Verification content must not be logged.
				}

			}

			public info(...params: Array<any>): void {

				if (this.debugLevel >= Log.LOG_LEVEL_INFO) {
					// Verification content must not be logged.
				}

			}

			public logToContainer(content: any) { /* No image or OCR debug output. */
			}

			public static genericLog(...params: Array<any>): void {

				let debug = new Debug.Log(Debug.Log.LOG_LEVEL_INFO);
				debug.info(params);

			}

		}

	}

}
