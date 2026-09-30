import { canonicalize } from '@ne-psd/contracts';
import { loadPrompt } from '../prompts/prompt-registry.js';
import { assertInvocationAllowed } from '../profiles/invocation-policy.js';
import { ModelProfileRegistry } from '../profiles/profile-registry.js';
import { invokeBounded, type ModelTransport } from '../transport/model-transport.js';
import { parseAndValidateStrictJson } from '../validation/strict-json.js';
import { preflightQualifiedPacket, type QualifiedTokenCounter } from '../budget/qualified-token-count.js';
import { admittedActions } from './action-catalog.js';
import { DiagnosticRequestSchema, DiagnosticResultSchema, DIAGNOSTIC_RESULT_SCHEMA, type DiagnosticRequest } from './schema.js';
export class DiagnosticModelError extends Error { readonly code = 'DIAGNOSTIC_MODEL_OUTPUT_INVALID'; }
export async function diagnose(input: DiagnosticRequest, transport: ModelTransport, modelProfileId: string, registry: ModelProfileRegistry, options: { safeCleanup?: boolean; knownCause?: boolean; correctionCode?: string; visualAttestation?: boolean; signal: AbortSignal; deadlineMs?: number; tokenCounter: QualifiedTokenCounter; safetyTokens?: number }) {
  const request = DiagnosticRequestSchema.parse(input); const profile = registry.get(modelProfileId)?.profile; if (!profile) throw new Error('MODEL_PROFILE_NOT_FOUND');
  assertInvocationAllowed({ trigger: 'foreground', jobKind: 'diagnosis', profile, explicitSelection: true, registry }); const prompt = await loadPrompt('diagnostic');
  if (request.promptSha256 !== prompt.sha256) throw new Error('DIAGNOSTIC_PROMPT_HASH_MISMATCH');
  const allowed = admittedActions({ attempt: request.attempt, allowedActions: request.allowedActions, domainError: request.domainError, ...options }); if (allowed.length === 0) throw new Error('DIAGNOSTIC_NO_ADMITTED_ACTION');
  const user = { ...request, allowedActions: allowed }; const userText = canonicalize(user); const packet = { profile, sessionId: request.sessionId, messages: [{ role: 'system' as const, content: prompt.text }, { role: 'user' as const, content: userText }] as const, responseSchema: DIAGNOSTIC_RESULT_SCHEMA, sampling: { temperature: 0 as const, stream: false as const }, maxOutputBytes: 256 * 1024, maxOutputTokens: profile.maxOutputTokens, deadlineMs: options.deadlineMs ?? 300000, signal: options.signal }; preflightQualifiedPacket(registry.get(modelProfileId)!, options.tokenCounter, packet, options.safetyTokens ?? 1024); const raw = await invokeBounded(transport, packet);
  let result; try { result = parseAndValidateStrictJson(raw.raw, (value) => DiagnosticResultSchema.parse(value)); } catch (error) { throw new DiagnosticModelError(String(error)); }
  const refs = new Set(request.evidenceRefs); const blockedActions = new Set(['WAIT_FOR_REQUIRED_EVIDENCE', 'OPERATOR_RECOVERY_REQUIRED', 'REQUALIFY_TEMPLATE', 'REQUALIFY_BACKEND', 'REQUALIFY_MODEL', 'TERMINAL_FAILURE']); const inconsistentStatus = (blockedActions.has(result.actionCode) && result.status !== 'blocked') || (!blockedActions.has(result.actionCode) && result.status !== 'diagnosed'); if (result.requestId !== request.requestId || result.sessionId !== request.sessionId || result.subjectId !== request.subjectId || result.evidenceSha256 !== request.evidenceSha256 || result.promptSha256 !== request.promptSha256 || !allowed.includes(result.actionCode as never) || inconsistentStatus || result.evidenceRefs.some((ref) => !refs.has(ref)) || (result.cause !== null && result.cause.evidenceRefs.some((ref) => !refs.has(ref)))) throw new DiagnosticModelError('DIAGNOSTIC_BINDING_OR_ACTION_INVALID');
  return result;
}
