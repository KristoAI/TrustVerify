
namespace AvsToken {

	export function main() {
		AvsFactory.SelfieAgeDetectionPage.Config.MIN_ALLOWED_AVERAGE_AGE = Math.max(25, Number((<any>Application).requiredAge || 18) + 7);

		AvsFactory.StartPage.Config.create({
			verificationVersion : Application.verificationVersion,
			partnerId           : Application.p,
			payload             : Application.d,
			sessionId           : Application.sessionId,
			partnerColorConfig  : Application.partnerColorConfig,
			verificationTypeList: Application.verificationTypeList,
		});

		AvsFactory.StartPage.init();
	}

}
