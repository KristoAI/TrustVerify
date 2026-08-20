namespace Avs {

	export namespace Helper {

		export class WebcamUtility {

			private virtualCameraPatterns: string[];
			private virtualCameraRegex: RegExp;
			private suspiciousPatterns: {
				[key: string]: RegExp;
			};

			constructor() {

				this.virtualCameraPatterns = [
					// Popular Virtual Camera Software
					'obs', 'obs-camera', 'obs virtual camera', 'obs studio',
					'manycam', 'many cam', 'manycam virtual webcam',
					'splitcam', 'split cam', 'splitcam video driver',
					'xsplit', 'xsplit vcam', 'xsplit broadcaster',
					'streamlabs', 'streamlabs obs', 'streamlabs virtual camera',
					'wirecast', 'wirecast virtual camera',

					// CyberLink Software
					'youcam', 'you cam', 'cyberlink youcam', 'perfectcam',

					// Other Popular Virtual Cameras
					'altercam', 'alter cam',
					'webcamoid', 'webcam oid',
					'snap camera', 'snapcamera', 'snap cam',
					'chromacam', 'chroma cam',
					'virtual cam', 'virtualcam', 'virtual camera',
					'logitech capture',
					'nvidia broadcast', 'nvidia rtx voice',

					// Mobile/Phone Camera Apps
					'droidcam', 'droid cam', 'droidcamx',
					'epoccam', 'epoc cam', 'elgato epoccam',
					'iriun', 'iriun webcam',
					'ip webcam', 'ipwebcam',
					'camo', 'camo studio',

					// Professional/Streaming Software
					'vmix', 'v-mix', 'vmix virtual camera',
					'ecamm', 'ecamm live',
					'mmhmm', 'mmhmm virtual camera',
					'reincubate camo',
					'continuity camera',

					// Open Source/Free Software
					'v4l2loopback', 'v4l2 loopback',
					'fakecam', 'fake cam',
					'virtual webcam', 'virtual web cam',
					'dummy camera', 'test camera',

					// Generic Virtual Device Names
					'virtual', 'fake', 'dummy', 'test', 'mock',
					'simulator', 'emulator', 'software',

					// Camera Brand Software (when used as virtual cameras)
					'canon eos webcam', 'canon webcam utility',
					'sony imaging edge', 'sony webcam',
					'nikon webcam utility',
					'fujifilm x webcam',
					'olympus om-d webcam',
					'panasonic lumix webcam',

					// Video Conferencing with Virtual Features
					'zoom virtual camera', 'teams camera',
					'skype camera', 'discord camera',

					// Game Streaming Software
					'gameshow', 'game show',
					'action', 'mirillis action',
					'bandicam', 'bandi cam',
					'camtasia', 'cam tasia',

					// Additional Virtual Camera Software
					'facerig', 'face rig',
					'animaze', 'ani maze',
					'vcam', 'v cam',
					'webcam studio', 'webcamstudio',
					'cheese', // Linux webcam software
					'guvcview', // Linux camera viewer

					// AI/Filter Camera Apps
					'beauty cam', 'beautycam',
					'perfect365', 'perfect 365',
					'faceapp', 'face app',
					'msqrd', 'avatarify',

					// Additional patterns that might indicate virtual cameras
					'screen capture', 'desktop capture',
					'display capture', 'window capture',
					'broadcaster', 'streamer', 'streaming'
				];

				this.virtualCameraRegex = new RegExp(
					this.virtualCameraPatterns
					    .map(pattern => pattern.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'))
					    .join('|'),
					'i'
				);

				this.suspiciousPatterns = {
					generic  : /^(camera|webcam|video|device|usb)\s*\d*$/i,
					loopback : /loopback|loop\s*back/i,
					capture  : /capture|screen|display|desktop|window/i,
					virtual  : /virtual|fake|dummy|test|mock|sim/i,
					software : /software|app|program|tool/i,
					streaming: /stream|broadcast|live|obs|xsplit/i
				};

			}

			public analyzeDevice(device: IVideoDevice): IAnalysisResponse {

				const label    = device.label.toLowerCase();
				const deviceId = device.deviceId;

				const analysis: IAnalysisResponse = {
					isVirtual   : false,
					isSuspicious: false,
					confidence  : 0,
					reasons     : [],
					patterns    : {}
				};

				if (this.virtualCameraRegex.test(label)) {
					analysis.isVirtual = true;
					analysis.confidence += 90;
					analysis.reasons.push('Matches known virtual camera software pattern');

					for (const pattern of this.virtualCameraPatterns) {
						if (label.includes(pattern)) {
							analysis.patterns.matched = pattern;
							break;
						}
					}
				}

				for (let key in this.suspiciousPatterns) {
					let regex = this.suspiciousPatterns[key];
					if (regex.test(label)) {
						analysis.patterns[key] = true;
						analysis.isSuspicious  = true;
						analysis.confidence += 30;
						analysis.reasons.push(`Matches ` + key + ` pattern`);
					}
				}

				if (this.analyzeDeviceId(deviceId)) {
					analysis.isSuspicious = true;
					analysis.confidence += 20;
					analysis.reasons.push('Suspicious device ID pattern');
				}

				if (!device.label || device.label.trim() === '' || device.label === 'Default') {
					analysis.isSuspicious = true;
					analysis.confidence += 15;
					analysis.reasons.push('Empty or default device label');
				}

				if (analysis.confidence >= 60) {
					analysis.isVirtual = true;
				}
				else if (analysis.confidence >= 30) {
					analysis.isSuspicious = true;
				}

				return analysis;
			}

			public analyzeDeviceId(deviceId: string) {
				// Some virtual cameras use predictable or default device IDs
				const suspiciousIdPatterns = [
					/^default$/i,
					/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // Some virtual cameras use generic UUIDs
					/virtual|fake|dummy/i,
					/^(test|mock|sim)/i
				];

				return suspiciousIdPatterns.some(pattern => pattern.test(deviceId));
			}

		}

		export interface IAnalysisResponse {
			isVirtual: boolean,
			isSuspicious: boolean,
			confidence: number,
			reasons: string[],
			patterns: any
		}

		export interface IVideoDevice {
			deviceId: string;
			label: string;
		}

	}

}
