import { readFile } from 'node:fs/promises';
import { canonicalize, type ModelProfile } from '@ne-psd/contracts';
import type { QualifiedTokenCounter } from '../budget/qualified-token-count.js';
import type { RuntimeProbe } from '../cli/qualify-model.js';
import { verifyModel } from '../cli/verify-model.js';
import { ModelQualificationSchema, type ModelQualification } from './qualification-schema.js';
import { ModelProfileRegistry, type RegisteredProfile } from './profile-registry.js';

const issued = new WeakSet<object>();
const trialBrand: unique symbol = Symbol('candidate-trial');
export type CandidateTrialAdmission = Readonly<{
  [trialBrand]: true;
  role: 'planner' | 'reviewer';
  profile: ModelProfile;
  candidate: ModelQualification;
  probe: RuntimeProbe;
  counter: QualifiedTokenCounter;
  record: RegisteredProfile;
}>;
export const isCandidateTrialAdmission = (value: unknown): value is CandidateTrialAdmission => !!value && typeof value === 'object' && issued.has(value);
const same = (left: unknown, right: unknown) => canonicalize(left) === canonicalize(right);
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;

/** One process-local, nonproduction admission for measuring an artifact-verified candidate. */
export async function admitCandidateTrial(options: {
  manifestPath: string;
  expectedPlatform: NodeJS.Platform;
  probe: RuntimeProbe;
  counter: QualifiedTokenCounter;
  role: 'planner' | 'reviewer';
}): Promise<{ registry: ModelProfileRegistry; admission: CandidateTrialAdmission; profile: ModelProfile; counter: QualifiedTokenCounter }> {
  const verified = await verifyModel({ manifest: options.manifestPath, expectedPlatform: options.expectedPlatform, artifactOnly: true });
  if (!verified.ok || !('artifactVerified' in verified) || !verified.artifactVerified) throw new Error('TRIAL_ARTIFACT_UNVERIFIED');
  const candidate = ModelQualificationSchema.parse(JSON.parse(await readFile(options.manifestPath, 'utf8')));
  const { profile, artifact } = candidate;
  const probe = options.probe, counter = options.counter;
  if (candidate.fixture || candidate.stage !== 'artifactVerified' || !candidate.artifactVerified || candidate.runtimeQualified || !artifact ||
      artifact.resources.os !== options.expectedPlatform ||
      profile.provenance.kind !== 'local' || probe.profileId !== profile.profileId || probe.modelId !== profile.modelId ||
      probe.artifactSha256 !== profile.provenance.artifactSha256 || probe.chatTemplateSha256 !== profile.provenance.chatTemplateSha256 ||
      probe.tokenizerId !== artifact.tokenizer || probe.runtimeBuild !== artifact.runtimeBuild ||
      !positive(probe.contextTokens) || probe.contextTokens < profile.contextTokens || !positive(probe.maxOutputTokens) || probe.maxOutputTokens < profile.maxOutputTokens ||
      !probe.jsonSchema || !probe.qualifiedTransport || !probe.qualifiedSampling ||
      !Array.isArray(probe.evidenceRefs) || probe.evidenceRefs.length === 0 ||
      (options.role === 'reviewer' && (!profile.capabilities.vision || !probe.vision || !probe.imageInput || !probe.visionLimits ||
        !Object.values(probe.visionLimits).every(positive))) ||
      counter.profileId !== profile.profileId || !same(counter.provenance, profile.provenance) ||
      counter.tokenizerId !== artifact.tokenizer || counter.chatTemplateId !== artifact.chatTemplate ||
      counter.runtimeBuild !== artifact.runtimeBuild || counter.runtimeContextTokens !== probe.contextTokens ||
      !probe.evidenceRefs.includes(counter.qualificationEvidencePath)) throw new Error('TRIAL_RUNTIME_PROBE_MISMATCH');
  const registry = new ModelProfileRegistry();
  const record = registry.register(profile);
  if (record.selectable || record.qualification !== null) throw new Error('TRIAL_PRODUCTION_SELECTION_FORBIDDEN');
  const admission = Object.freeze({ [trialBrand]: true as const, role: options.role, profile: record.profile, candidate, probe, counter, record });
  issued.add(admission);
  return { registry, admission, profile: record.profile, counter };
}

export function trialMatches(admission: CandidateTrialAdmission | undefined, record: RegisteredProfile, counter?: QualifiedTokenCounter): boolean {
  return isCandidateTrialAdmission(admission) && admission.record === record && !record.selectable && record.qualification === null &&
    same(admission.profile, record.profile) && (counter === undefined || counter === admission.counter);
}
