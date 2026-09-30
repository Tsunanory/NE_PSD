import type { PhotoshopBackend } from '@ne-psd/contracts';

export type RecoveryResult = { safe: boolean; evidencePaths: string[]; code: 'SAFE' | 'AMBIGUOUS_STATE' | 'RECOVERY_FAILED' };
export function isAmbiguousMutationError(error: unknown): boolean { return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'AMBIGUOUS_STATE'); }
export function isRetryableTransportError(error: unknown): boolean { return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'TRANSPORT_FAILURE'); }
export async function recoverReadOnly(backend: PhotoshopBackend, jobId: string, signal: AbortSignal): Promise<RecoveryResult> {
  try {
    const result = await backend.recover(jobId, signal);
    const validEvidence = Array.isArray(result?.evidencePaths) && result.evidencePaths.every((path) => typeof path === 'string');
    const evidencePaths = validEvidence ? result.evidencePaths : [];
    return result?.safe === true && validEvidence ? { safe: true, evidencePaths, code: 'SAFE' } : { safe: false, evidencePaths, code: 'AMBIGUOUS_STATE' };
  } catch { return { safe: false, evidencePaths: [], code: 'RECOVERY_FAILED' }; }
}
