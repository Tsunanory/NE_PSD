import { ACTION_CODES, type ActionCode } from './schema.js';
export const DIAGNOSTIC_CORRECTION_CODES = ['REAPPLY_APPROVED_CONFIGURATION'] as const;
export const DIAGNOSTIC_RETRY_CAUSE_CODES = ['CONFIGURATION_DRIFT'] as const;
export function admittedActions(input: { attempt: 1 | 2; allowedActions: readonly string[]; domainError: { code: string; category: string }; safeCleanup?: boolean; knownCause?: boolean; correctionCode?: string; visualAttestation?: boolean }): ActionCode[] {
  const requested = new Set(input.allowedActions); let allowed = ACTION_CODES.filter((code) => requested.has(code));
  if (input.attempt === 2) allowed = allowed.filter((code) => code !== 'RETRY_FRESH_COPY');
  if (input.domainError.category === 'ambiguousState') allowed = allowed.filter((code) => code === 'WAIT_FOR_REQUIRED_EVIDENCE' || code === 'OPERATOR_RECOVERY_REQUIRED');
  else if (/^(MODEL_|TOKEN_|VISION_|CODEX_|LOCAL_)/i.test(input.domainError.code)) allowed = allowed.filter((code) => code === 'REQUALIFY_MODEL');
  else if (/TIMEOUT|AMBIGUOUS/i.test(input.domainError.code)) allowed = allowed.filter((code) => code === 'WAIT_FOR_REQUIRED_EVIDENCE' || code === 'OPERATOR_RECOVERY_REQUIRED');
  else if (/UNSUPPORTED/i.test(input.domainError.code)) allowed = allowed.filter((code) => code === 'REQUALIFY_BACKEND');
  if (!input.visualAttestation) allowed = allowed.filter((code) => code !== 'CORRECT_CONFIGURATION' && code !== 'RETRY_FRESH_COPY');
  if (!input.safeCleanup || !input.knownCause || input.attempt !== 1 || !DIAGNOSTIC_RETRY_CAUSE_CODES.some((code) => code === input.domainError.code) || !DIAGNOSTIC_CORRECTION_CODES.some((code) => code === input.correctionCode)) allowed = allowed.filter((code) => code !== 'RETRY_FRESH_COPY');
  return allowed;
}
