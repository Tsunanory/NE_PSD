import { canonicalize, ConfigurationProposalSchema, InspectionReportSchema, OutputSpecSchema, type FitMode, type OutputSpec } from '@ne-psd/contracts';
import { loadPrompt } from '../prompts/prompt-registry.js';
import { assertInvocationAllowed } from '../profiles/invocation-policy.js';
import { ModelProfileRegistry } from '../profiles/profile-registry.js';
import { invokeBounded, type ModelTransport } from '../transport/model-transport.js';
import { parseAndValidateStrictJson } from '../validation/strict-json.js';
import { preflightQualifiedPacket, type QualifiedTokenCounter } from '../budget/qualified-token-count.js';
import type { CandidateTrialAdmission } from '../profiles/candidate-trial.js';
import { validateProposal } from './validate-proposal.js';
import { PlannerRequestSchema, PLANNER_RESPONSE_SCHEMA } from './request-schema.js';
export type PlannerRequest = { inspection: unknown; instruction: string; instructionEvidence?: string[]; modelProfileId: string; registry: ModelProfileRegistry; transport: ModelTransport; sessionId: string; requestedFitMode?: FitMode; requestedOutput?: OutputSpec | undefined; deadlineMs?: number; signal: AbortSignal; tokenCounter: QualifiedTokenCounter; safetyTokens?: number; trialAdmission?: CandidateTrialAdmission | undefined };
export async function proposeConfiguration(request: PlannerRequest) {
  const inspection = InspectionReportSchema.parse(request.inspection); const profile = request.registry.get(request.modelProfileId)?.profile;
  if (!profile) throw new Error('MODEL_PROFILE_NOT_FOUND');
  assertInvocationAllowed({ trigger: 'foreground', jobKind: 'planning', profile, explicitSelection: true, registry: request.registry, trialAdmission: request.trialAdmission });
  const prompt = await loadPrompt('planner'); const requestedOutput = request.requestedOutput === undefined ? null : OutputSpecSchema.parse(request.requestedOutput); const user = { kind: 'configuration-proposal', schemaVersion: 1, instruction: request.instruction, inspection, requestedFitMode: request.requestedFitMode ?? null, requestedOutput, instructionEvidence: request.instructionEvidence ?? [] }; PlannerRequestSchema.parse(user);
  const userText = canonicalize(user); const packet = { profile, sessionId: request.sessionId, messages: [{ role: 'system' as const, content: prompt.text }, { role: 'user' as const, content: userText }] as const, responseSchema: PLANNER_RESPONSE_SCHEMA, sampling: { temperature: 0 as const, stream: false as const }, maxOutputBytes: 256 * 1024, maxOutputTokens: profile.maxOutputTokens, deadlineMs: request.deadlineMs ?? 300000, signal: request.signal };
  preflightQualifiedPacket(request.registry.get(request.modelProfileId)!, request.tokenCounter, packet, request.safetyTokens ?? 1024, request.trialAdmission);
  const response = await invokeBounded(request.transport, packet);
  return validateProposal(inspection, parseAndValidateStrictJson(response.raw, (value) => ConfigurationProposalSchema.parse(value)), request.instructionEvidence ?? [], request.requestedFitMode, requestedOutput);
}
