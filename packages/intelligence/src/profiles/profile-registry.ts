import { canonicalize, ModelProfileSchema, sha256Json, type DomainError, type ModelProfile } from '@ne-psd/contracts';
import { ModelQualificationSchema, QualifiedModelRecordSchema, type ModelQualification } from './qualification-schema.js';
import type { QualifiedTokenCounter } from '../budget/qualified-token-count.js';
import type { RuntimeProbe } from '../cli/qualify-model.js';
export type QualificationAdapter = { inspect?: (p: ModelProfile, s: AbortSignal) => Promise<{ available: boolean; errors: DomainError[] }>; qualify?: (p: ModelProfile, s: AbortSignal) => Promise<{ qualified: boolean; evidencePaths: string[]; errors: DomainError[]; qualification?: ModelQualification }>; inspectModelProfile?: QualificationAdapter['inspect']; qualifyModelProfile?: QualificationAdapter['qualify'] };
export type RegisteredProfile = Readonly<{ profile: ModelProfile; qualification: ModelQualification | null; selectable: boolean }>;
const error = (code: string, message: string): DomainError => ({ code, category: 'capability', message, retryable: false, evidencePaths: [] });
const safeEvidencePath = (path: string) => path.length > 0 && !path.startsWith('/') && !path.includes('\\') && !path.split('/').some((part) => part === '' || part === '.' || part === '..');
const trustedQualifications = new WeakSet<object>();
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const freezeDeep = <T>(value: T): T => { if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child); } return value; };
const abort = (s: AbortSignal) => { if (s.aborted) throw new DOMException('The operation was aborted', 'AbortError'); };

const digestPattern = /^[a-f0-9]{64}$/;
const restorationIssued = new WeakSet<object>();
const restorationConsumed = new WeakSet<object>();
const restorationBrand: unique symbol = Symbol('model-profile-restoration');

export type ModelQualificationRestorationCandidate = Readonly<{
  profile: ModelProfile;
  qualification: ModelQualification;
  profileSha256: string;
  qualificationSha256: string;
  evidencePaths: readonly string[];
}>;
export type ModelQualificationRestorationVerification = Readonly<{
  reportSha256: string;
  v2ReleaseGateSha256: string;
  runtimeProbe: RuntimeProbe;
  tokenCounter: QualifiedTokenCounter;
  evidencePaths: readonly string[];
}>;
export type ModelQualificationRestorationVerifier = (candidate: ModelQualificationRestorationCandidate) => Promise<ModelQualificationRestorationVerification | null>;
export type ModelProfileRestorationSeal = Readonly<{
  [restorationBrand]: true;
  profile: ModelProfile;
  qualification: ModelQualification;
  profileSha256: string;
  qualificationSha256: string;
  reportSha256: string;
  v2ReleaseGateSha256: string;
  runtimeProbe: RuntimeProbe;
  runtimeProbeSha256: string;
  tokenCounterSha256: string;
  evidencePaths: readonly string[];
}>;

const restorationError = (code: string, detail: string): Error => new Error(`${code}:${detail}`);
const same = (left: unknown, right: unknown) => canonicalize(left) === canonicalize(right);
const sortedUnique = (paths: readonly string[]) => [...new Set(paths)].sort();
const samePaths = (left: readonly string[], right: readonly string[]) => same(sortedUnique(left), sortedUnique(right));
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
const probeIdentity = (probe: RuntimeProbe) => sha256Json(probe);
const counterIdentity = (counter: QualifiedTokenCounter) => sha256Json({ profileId: counter.profileId, provenance: counter.provenance, qualificationEvidencePath: counter.qualificationEvidencePath, tokenizerId: counter.tokenizerId, chatTemplateId: counter.chatTemplateId, runtimeBuild: counter.runtimeBuild, runtimeContextTokens: counter.runtimeContextTokens });

function candidateFor(profile: ModelProfile, qualification: ModelQualification): ModelQualificationRestorationCandidate {
  const evidencePaths = sortedUnique([...qualification.evidencePaths, ...(qualification.artifact?.resources.evidencePaths ?? [])]);
  return freezeDeep({ profile: clone(profile), qualification: clone(qualification), profileSha256: sha256Json(profile), qualificationSha256: sha256Json(qualification), evidencePaths });
}

function validateVerification(candidate: ModelQualificationRestorationCandidate, verification: ModelQualificationRestorationVerification): ModelProfileRestorationSeal {
  const profile = ModelProfileSchema.parse(candidate.profile);
  const qualification = QualifiedModelRecordSchema.parse(candidate.qualification);
  if (!same(qualification.profile, profile)) throw restorationError('RESTORATION_PROFILE_MISMATCH', 'qualification profile differs from selected profile');
  if (qualification.fixture || !qualification.artifactVerified || !qualification.runtimeQualified || qualification.stage !== 'runtimeQualified') throw restorationError('RESTORATION_QUALIFICATION_UNAVAILABLE', 'fixture or incomplete qualification cannot be restored');
  if (candidate.profileSha256 !== sha256Json(profile) || candidate.qualificationSha256 !== sha256Json(qualification)) throw restorationError('RESTORATION_DIGEST_MISMATCH', 'self-declared profile or qualification digest');
  const probe = verification.runtimeProbe;
  const counter = verification.tokenCounter;
  const artifact = qualification.artifact;
  const allEvidence = [...candidate.evidencePaths, ...probe.evidenceRefs, counter.qualificationEvidencePath];
  if (!allEvidence.every(safeEvidencePath) || !verification.evidencePaths.every(safeEvidencePath) || !samePaths(verification.evidencePaths, allEvidence)) throw restorationError('RESTORATION_EVIDENCE_MISMATCH', 'evidence paths are stale, unsafe or incomplete');
  if (!digestPattern.test(verification.reportSha256) || !digestPattern.test(verification.v2ReleaseGateSha256)) throw restorationError('RESTORATION_DIGEST_MISMATCH', 'report or V2 release-gate digest is invalid');
  if (probe.profileId !== profile.profileId || probe.modelId !== profile.modelId || probe.jsonSchema !== profile.capabilities.jsonSchema || probe.vision !== profile.capabilities.vision || probe.imageInput !== profile.capabilities.vision) throw restorationError('RESTORATION_RUNTIME_MISMATCH', 'runtime probe does not bind the profile');
  if (!positive(probe.contextTokens) || probe.contextTokens < profile.contextTokens || !positive(probe.maxOutputTokens) || probe.maxOutputTokens < profile.maxOutputTokens || !probe.qualifiedTransport || !probe.qualifiedSampling) throw restorationError('RESTORATION_RUNTIME_MISMATCH', 'runtime probe is not qualified');
  if (probe.vision && (!probe.visionLimits || !Object.values(probe.visionLimits).every(positive))) throw restorationError('RESTORATION_VISION_MISMATCH', 'vision limits are missing or invalid');
  if (!probe.vision && probe.visionLimits !== null) throw restorationError('RESTORATION_VISION_MISMATCH', 'text-only probe carries vision limits');
  if (profile.provenance.kind === 'local' && (probe.artifactSha256 !== profile.provenance.artifactSha256 || probe.chatTemplateSha256 !== profile.provenance.chatTemplateSha256)) throw restorationError('RESTORATION_RUNTIME_MISMATCH', 'runtime artifact binding differs from profile');
  if (artifact && (probe.tokenizerId !== artifact.tokenizer || probe.runtimeBuild !== artifact.runtimeBuild)) throw restorationError('RESTORATION_RUNTIME_MISMATCH', 'runtime artifact metadata differs from qualification');
  if (counter.profileId !== profile.profileId || !same(counter.provenance, profile.provenance) || counter.runtimeContextTokens !== probe.contextTokens || counter.qualificationEvidencePath === '') throw restorationError('RESTORATION_TOKEN_COUNTER_MISMATCH', 'token counter does not bind the runtime');
  if (artifact && (counter.tokenizerId !== artifact.tokenizer || counter.chatTemplateId !== artifact.chatTemplate || counter.runtimeBuild !== artifact.runtimeBuild)) throw restorationError('RESTORATION_TOKEN_COUNTER_MISMATCH', 'token counter metadata differs from qualification');
  const sealed = freezeDeep({ [restorationBrand]: true as const, profile: clone(profile), qualification: clone(qualification), profileSha256: sha256Json(profile), qualificationSha256: sha256Json(qualification), reportSha256: verification.reportSha256, v2ReleaseGateSha256: verification.v2ReleaseGateSha256, runtimeProbe: clone(probe), runtimeProbeSha256: probeIdentity(probe), tokenCounterSha256: counterIdentity(counter), evidencePaths: sortedUnique(verification.evidencePaths) });
  restorationIssued.add(sealed as object);
  return sealed;
}

/** Creates an opaque one-shot seal only after the caller verifies persisted evidence. */
export async function createModelProfileRestorationSeal(profile: ModelProfile, qualification: ModelQualification, verifier: ModelQualificationRestorationVerifier): Promise<ModelProfileRestorationSeal> {
  const parsedProfile = ModelProfileSchema.parse(profile);
  const parsedQualification = QualifiedModelRecordSchema.parse(qualification);
  const candidate = candidateFor(parsedProfile, parsedQualification);
  const verification = await verifier(candidate);
  if (!verification) throw restorationError('RESTORATION_VERIFICATION_FAILED', 'caller did not verify current evidence');
  return validateVerification(candidate, verification);
}

const isRestorationSeal = (value: unknown): value is ModelProfileRestorationSeal => !!value && typeof value === 'object' && restorationIssued.has(value);

export class ModelProfileRegistry {
  private readonly profiles = new Map<string, RegisteredProfile>();
  register(profile: ModelProfile, options: { fixture?: boolean; qualification?: ModelQualification | null } = {}): RegisteredProfile {
    const p = ModelProfileSchema.parse(profile);
    const parsed = options.qualification === null || options.qualification === undefined ? null : QualifiedModelRecordSchema.safeParse(options.qualification);
    const q = parsed?.success && trustedQualifications.has(options.qualification as object) ? parsed.data : null;
    const evidence = q ? [...q.evidencePaths, ...(q.artifact?.resources.evidencePaths ?? [])] : [];
    const bound = q !== null && !options.fixture && !q.fixture && same(q.profile, p) && evidence.every(safeEvidencePath);
    const r = freezeDeep({ profile: clone(p), qualification: bound ? clone(q) : null, selectable: bound });
    this.profiles.set(p.profileId, r);
    return r;
  }
  async restore(profile: ModelProfile, qualification: ModelQualification, source: ModelProfileRestorationSeal | ModelQualificationRestorationVerifier): Promise<RegisteredProfile> {
    if (!isRestorationSeal(source) && typeof source !== 'function') throw restorationError('RESTORATION_REPLAY_OR_BINDING_MISMATCH', 'admission must be an issued seal or verifier');
    const seal = isRestorationSeal(source) ? source : await createModelProfileRestorationSeal(profile, qualification, source);
    const p = ModelProfileSchema.parse(profile);
    const q = QualifiedModelRecordSchema.parse(qualification);
    if (!isRestorationSeal(seal) || restorationConsumed.has(seal) || !same(seal.profile, p) || !same(seal.qualification, q)) throw restorationError('RESTORATION_REPLAY_OR_BINDING_MISMATCH', 'seal is forged, stale or already consumed');
    restorationConsumed.add(seal);
    const record = freezeDeep({ profile: clone(p), qualification: clone(q), selectable: true as const });
    this.profiles.set(p.profileId, record);
    return record;
  }
  async registerRestored(profile: ModelProfile, qualification: ModelQualification, source: ModelProfileRestorationSeal | ModelQualificationRestorationVerifier): Promise<RegisteredProfile> { return this.restore(profile, qualification, source); }
  get(id: string) { return this.profiles.get(id); }
}
async function inspectAdapter(profile: ModelProfile, signal: AbortSignal, adapter?: QualificationAdapter) { abort(signal); const fn = adapter?.inspect ?? adapter?.inspectModelProfile; if (fn) { const r = await fn(profile, signal); abort(signal); return r; } if (profile.provider === 'local-qwen') return { available: false, errors: [error('MODEL_ARTIFACT_UNVERIFIED', 'exact Qwen3.8-27B artifact provenance is unverified by plan')] }; return { available: profile.provenance.kind === 'remote', errors: profile.provenance.kind === 'remote' ? [] : [error('MODEL_ARTIFACT_UNVERIFIED', 'model artifact provenance is unverified')] }; }
export async function inspectModelProfile(profile: ModelProfile, signal: AbortSignal, adapter?: QualificationAdapter) { const p = ModelProfileSchema.safeParse(profile); if (!p.success) return { available: false, errors: [error('INVALID_MODEL_PROFILE', p.error.message)] }; return inspectAdapter(p.data, signal, adapter); }
export async function qualifyModelProfile(profile: ModelProfile, signal: AbortSignal, adapter?: QualificationAdapter) { const inspected = await inspectModelProfile(profile, signal, adapter); abort(signal); if (!inspected.available) return { qualified: false, evidencePaths: [], errors: inspected.errors }; const fn = adapter?.qualify ?? adapter?.qualifyModelProfile; if (!fn) return { qualified: false, evidencePaths: [], errors: [error('MODEL_RUNTIME_UNQUALIFIED', 'runtime acceptance corpus is incomplete')] }; const result = await fn(profile, signal); abort(signal); if (!result.qualified) return result; if (!result.qualification) return { qualified: false, evidencePaths: [], errors: [error('QUALIFICATION_EVIDENCE_REQUIRED', 'qualification requires validated artifact and runtime evidence')] }; const checked = QualifiedModelRecordSchema.safeParse(result.qualification); if (!checked.success) return { qualified: false, evidencePaths: [], errors: [error('INVALID_QUALIFICATION', checked.error.message)] }; if (JSON.stringify(checked.data.profile) !== JSON.stringify(profile) || JSON.stringify(checked.data.evidencePaths) !== JSON.stringify(result.evidencePaths) || checked.data.fixture) return { qualified: false, evidencePaths: [], errors: [error('QUALIFICATION_BINDING_MISMATCH', 'qualification evidence does not bind the selected profile')] }; const unsafe = [...result.evidencePaths, ...checked.data.artifact?.resources.evidencePaths ?? []].some((p) => p.startsWith('/') || p.includes('\\') || p.split('/').includes('..')); if (unsafe) return { qualified: false, evidencePaths: [], errors: [error('UNSAFE_QUALIFICATION_EVIDENCE', 'qualification evidence paths must be relative and contained')] }; trustedQualifications.add(checked.data); return { ...result, qualification: checked.data }; }
