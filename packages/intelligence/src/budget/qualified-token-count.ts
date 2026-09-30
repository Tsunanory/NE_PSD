import type { ModelProfile } from '@ne-psd/contracts';
import { canonicalize } from '@ne-psd/contracts';
import type { RegisteredProfile } from '../profiles/profile-registry.js';
import { trialMatches, type CandidateTrialAdmission } from '../profiles/candidate-trial.js';
import type { TransportRequest } from '../transport/model-transport.js';
import { preflightContextBudget, type ContextBudget } from './context-budget.js';

export type PacketTokenCounts = { systemTokens: number; userTokens: number; schemaTokens: number; wrapperTokens: number; imageTokens: number };
/** Supplied by a qualified runtime/tokenizer adapter, never by model output. */
export type QualifiedTokenCounter = {
  profileId: string;
  provenance: ModelProfile['provenance'];
  qualificationEvidencePath: string;
  tokenizerId: string;
  chatTemplateId: string;
  runtimeBuild: string;
  runtimeContextTokens: number;
  countPacket(request: TransportRequest): PacketTokenCounts;
};
const valid = (n: number) => Number.isSafeInteger(n) && n >= 0;
export function preflightQualifiedPacket(record: RegisteredProfile, counter: QualifiedTokenCounter, request: TransportRequest, safetyTokens: number, trialAdmission?: CandidateTrialAdmission): ContextBudget {
  const profile = record.profile;
  const artifact = record.qualification?.artifact;
  const trial = trialMatches(trialAdmission, record, counter) ? trialAdmission : undefined;
  const selectedArtifact = trial?.candidate.artifact ?? artifact;
  const qualifiedContext = trial?.probe.contextTokens ?? Number(artifact?.runtimeSettings.contextTokens);
  const permitted = trial !== undefined || (record.selectable && !!record.qualification?.runtimeQualified);
  const evidencePaths = trial?.probe.evidenceRefs ?? record.qualification?.evidencePaths ?? [];
  if (!permitted || !selectedArtifact || counter.profileId !== profile.profileId || canonicalize(counter.provenance) !== canonicalize(profile.provenance) || !evidencePaths.includes(counter.qualificationEvidencePath) || counter.tokenizerId !== selectedArtifact.tokenizer || counter.chatTemplateId !== selectedArtifact.chatTemplate || counter.runtimeBuild !== selectedArtifact.runtimeBuild || !Number.isSafeInteger(qualifiedContext) || qualifiedContext <= 0 || !Number.isSafeInteger(counter.runtimeContextTokens) || counter.runtimeContextTokens !== qualifiedContext) throw new Error('TOKEN_COUNTER_UNQUALIFIED');
  if (request.profile.profileId !== profile.profileId || request.messages.length !== 2 || request.messages[0].role !== 'system' || request.messages[1].role !== 'user') throw new Error('TOKEN_PACKET_MISMATCH');
  const counts = counter.countPacket(request);
  if (!counts || ![counts.systemTokens, counts.userTokens, counts.schemaTokens, counts.wrapperTokens, counts.imageTokens].every(valid)) throw new Error('INVALID_QUALIFIED_TOKEN_COUNT');
  return preflightContextBudget({ ...counts, reservedOutputTokens: request.maxOutputTokens, safetyTokens, modelContextTokens: profile.contextTokens, runtimeContextTokens: counter.runtimeContextTokens });
}
