
namespace AvsToken {

	export function main() {

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
