namespace AvsFactory {
	export namespace ScanIdAgeVerificationPage {
		export class Event {
			public static init(): void {
				instance.event.on(
					Config.EVENT_NAME_PREFIX +
						"." +
						Avs.DataChannel.Webrtc.ON_WEBCAM_INIT_ERROR,
					(event: Avs.Event.Listener) => {
						instance.ui.ScanIdAgeVerificationTakePhotoButton.disable();
						$("#idCaptureStatus").text(
							"Camera unavailable. Allow camera access or browse an image.",
						);
					},
				);

				instance.event.on(
					Config.EVENT_NAME_PREFIX + "." + Avs.DataChannel.Webrtc.ON_VIDEO_PLAY,
					(event: Avs.Event.Listener) => {
						Method.repositionScanId();
						instance.ui.ScanIdAgeVerificationTakePhotoButton.enable();
						$("#idCaptureStatus").text("Hold steady, then take a photo.");

						instance.ui.ScanIdAgeVerificationLoadingLabelArea.setContent("");
						instance.ui.ScanIdAgeVerificationLoadingLabelArea.hide();

						//Method.loadDetectionLibrary();
					},
				);
			}
		}
	}
}
