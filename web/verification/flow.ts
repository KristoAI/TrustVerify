/** Live AI checks always include document reinforcement. */
export type VerificationMethod = 'selfie' | 'document';

export function verificationMethods(methods: readonly VerificationMethod[]): VerificationMethod[] {
  if (methods.includes('selfie')) return ['selfie', 'document'];
  return methods.includes('document') ? ['document'] : [];
}

export const selfieThreshold = (requiredAge: number) => Math.max(25, requiredAge);

export function selfieOutcome(methods: readonly VerificationMethod[], requiredAge: number, estimate: number): 'passed' | 'document-backup' {
  if (!methods.includes('selfie')) throw new Error('SELFIE_NOT_PERMITTED');
  if (Number.isFinite(estimate) && estimate >= selfieThreshold(requiredAge)) return 'passed';
  return 'document-backup';
}
