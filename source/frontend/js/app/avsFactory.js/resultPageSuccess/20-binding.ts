namespace AvsFactory { export namespace ResultPageSuccess { export class Binding { public static init(): void {
 instance.ui.ResultSuccessButton.onClick(() => {
  if (!instance.entity.VerificationStepGlobal.isVerified || !instance.entity.VerificationStepGlobal.successPayload) return;
  window.location.assign((<any>Application).completionBase + '?handoff=' + encodeURIComponent(instance.entity.VerificationStepGlobal.successPayload));
 });
} } } }
