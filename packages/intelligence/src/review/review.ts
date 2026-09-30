import { randomUUID } from 'node:crypto';
import { canonicalize, ReviewDecisionSchema, sha256Bytes, type IntelligenceService, type ModelProfile } from '@ne-psd/contracts';
import { z } from 'zod';
import { preflightQualifiedPacket, type QualifiedTokenCounter } from '../budget/qualified-token-count.js';
import { proposeConfiguration } from '../planner/propose.js';
import { assertInvocationAllowed } from '../profiles/invocation-policy.js';
import { inspectModelProfile, qualifyModelProfile, type QualificationAdapter, type ModelProfileRegistry } from '../profiles/profile-registry.js';
import { loadPrompt } from '../prompts/prompt-registry.js';
import { invokeBounded, type ModelTransport, type TransportRequest } from '../transport/model-transport.js';
import { parseAndValidateStrictJson } from '../validation/strict-json.js';
import { assertDeterministicReviewEvidence, ReviewGateError, validateRuntimeDecision, type ReviewContext } from './decision-validator.js';
import { prepareEvidenceRequest } from './evidence-request.js';
import { EvidenceValidator, type EvidenceReadLimits, type EvidenceSnapshot, type TrustedAttemptReader } from './evidence-validator.js';
import { inspectImageQuality, type ColorExportProof, type ColorEvidence, type ImageQualityPolicy } from './image-quality.js';
import { prepareVisionPayload } from './visual-inputs.js';
import { validateVisualAttestation, type TrustedAttestationReader } from './visual-attestation.js';

const REVIEW_RESPONSE_SCHEMA = z.toJSONSchema(ReviewDecisionSchema, { target: 'draft-2020-12' });
export type IntelligenceRuntimeDependencies = {
  registry: ModelProfileRegistry;
  transport: ModelTransport;
  counterFor(profileId: string): QualifiedTokenCounter | null;
  qualificationAdapter?: QualificationAdapter;
  readAttempt: TrustedAttemptReader;
  readLimits: EvidenceReadLimits;
  resolveAttemptRoot(jobId: string, assetId: string, attempt: 1 | 2): Promise<string>;
  imageQualityPolicy(snapshot: EvidenceSnapshot): Promise<ImageQualityPolicy | null>;
  colorTrace(snapshot: EvidenceSnapshot): Promise<{ relativePath: string; proofs: readonly ColorExportProof[] } | null>;
  readTrustedAttestation?: TrustedAttestationReader;
  safeCleanup(jobId: string, assetId: string, attempt: 1 | 2): Promise<boolean>;
  admissibleCorrections(jobId: string, assetId: string, attempt: 1 | 2, evidenceSha256: string): Promise<readonly string[]>;
  deadlineMs?: number;
  safetyTokens?: number;
};
const gate = (code: string, reason: string): never => { throw new ReviewGateError(code, reason); };
const ids = ['1', '2', '3'] as const;

export class RuntimeIntelligenceService implements IntelligenceService {
  private readonly evidenceValidator: EvidenceValidator;
  constructor(private readonly deps: IntelligenceRuntimeDependencies) { this.evidenceValidator = new EvidenceValidator(deps.readAttempt, deps.readLimits); }

  async inspectModelProfile(profile: ModelProfile, signal: AbortSignal) { return inspectModelProfile(profile, signal, this.deps.qualificationAdapter); }
  async qualifyModelProfile(profile: ModelProfile, signal: AbortSignal) {
    const result = await qualifyModelProfile(profile, signal, this.deps.qualificationAdapter);
    if (result.qualified && result.qualification) this.deps.registry.register(profile, { qualification: result.qualification });
    return { qualified: result.qualified, evidencePaths: result.evidencePaths, errors: result.errors };
  }
  async propose(input: Parameters<IntelligenceService['propose']>[0], signal: AbortSignal) {
    const counter = this.deps.counterFor(input.modelProfileId);
    if (!counter) return gate('TOKEN_COUNTER_UNQUALIFIED', 'selected planner has no qualified tokenizer adapter');
    return proposeConfiguration({ ...input, registry: this.deps.registry, transport: this.deps.transport, sessionId: randomUUID(), signal, tokenCounter: counter, ...(this.deps.safetyTokens === undefined ? {} : { safetyTokens: this.deps.safetyTokens }) });
  }

  async review(input: Parameters<IntelligenceService['review']>[0], modelProfileId: string, signal: AbortSignal) {
    if (signal.aborted) return gate('REVIEW_ABORTED', 'review cancelled');
    const attempt = input.evidence.attempt;
    const bundleRoot = await this.deps.resolveAttemptRoot(input.evidence.jobId, input.evidence.assetId, attempt);
    const snapshot = await this.evidenceValidator.validate({ bundleRoot, manifest: input.manifest, evidence: input.evidence, policy: input.policy });
    const record = this.deps.registry.get(modelProfileId);
    if (!record) return gate('REVIEW_PROFILE_UNQUALIFIED', 'selected reviewer unavailable');
    const profile = record.profile;
    const manual = snapshot.policy.visualGate === 'humanPerAsset';
    assertInvocationAllowed({ trigger: 'foreground', jobKind: 'review', manualAttestation: manual, profile, explicitSelection: true, registry: this.deps.registry });
    const prompt = await loadPrompt(manual ? 'manual-reviewer' : 'runtime-reviewer');
    if (snapshot.policy.promptSha256 !== prompt.sha256) return gate('REVIEW_PROMPT_MISMATCH', 'policy does not bind the packaged reviewer prompt');
    let attestationPassed = false;
    if (manual) {
      if (!this.deps.readTrustedAttestation) return gate('REVIEW_ATTESTATION_MISSING', 'trusted consumed attestation reader is unavailable');
      await validateVisualAttestation(snapshot, this.deps.readTrustedAttestation);
      attestationPassed = true;
    }
    const prepared = await prepareEvidenceRequest(snapshot);
    const policy = await this.deps.imageQualityPolicy(snapshot);
    if (policy && (policy.profileSha256 !== snapshot.job.profile.profileSha256 || policy.templateSha256 !== snapshot.job.profile.template.sha256 || canonicalize(policy.output) !== canonicalize(snapshot.job.profile.output))) return gate('REVIEW_QA_POLICY_MISMATCH', 'image policy is not bound to persisted template/output');
    const traceSelection = await this.deps.colorTrace(snapshot);
    let colorEvidence: ColorEvidence | null = null;
    if (traceSelection) {
      const file = snapshot.manifest.files.find((entry) => entry.relativePath === traceSelection.relativePath && entry.role === 'trace');
      if (!file) return gate('REVIEW_COLOR_TRACE_UNSEALED', 'color proof is absent from sealed trace set');
      const traceBytes = snapshot.getBytes(file.relativePath);
      colorEvidence = { traceBytes, traceSha256: sha256Bytes(traceBytes), proofs: traceSelection.proofs };
    }
    const artifacts = ids.map((id) => {
      const artifact = snapshot.evidence.artifacts.find((item) => item.variantId === id);
      if (!artifact) return gate('REVIEW_ARTIFACT_SET_INVALID', `variant ${id} missing`);
      return { variantId: Number(id) as 1 | 2 | 3, relativePath: artifact.path, bytes: snapshot.getBytes(artifact.path), sha256: artifact.sha256 };
    });
    const reference = prepared.images.find((image) => image.role === 'reference');
    const quality = await inspectImageQuality({ artifacts, output: snapshot.job.profile.output, policy, colorEvidence, ...(reference ? { reference: { bytes: reference.bytes, sha256: reference.sha256 } } : {}) });
    await snapshot.assertUnchanged();
    const sessionId = randomUUID(), reviewId = randomUUID();
    const context: ReviewContext = { job: snapshot.job, manifest: snapshot.manifest, evidence: snapshot.evidence, policy: snapshot.policy, evidenceSha256: snapshot.evidenceSha256, profile, sessionId, reviewId, promptSha256: prompt.sha256, imageQualityPassed: quality.passed, attestationPassed, safeCleanup: await this.deps.safeCleanup(snapshot.job.jobId, snapshot.manifest.assetId, attempt), admissibleCorrections: await this.deps.admissibleCorrections(snapshot.job.jobId, snapshot.manifest.assetId, attempt, snapshot.evidenceSha256) };
    assertDeterministicReviewEvidence(context);
    const userText = canonicalize({ ...prepared.userData, reviewId, sessionId, visualGate: snapshot.policy.visualGate, attestationVerified: attestationPassed, imageQuality: quality, imageIndex: prepared.images.map(({ bytes: _bytes, ...index }) => index) });
    const content = manual ? userText : (await prepareVisionPayload(prepared.images, record, userText)).content;
    const counter = this.deps.counterFor(modelProfileId);
    if (!counter) return gate('TOKEN_COUNTER_UNQUALIFIED', 'selected reviewer has no qualified tokenizer adapter');
    const packet: TransportRequest = { profile, sessionId, messages: [{ role: 'system', content: prompt.text }, { role: 'user', content }], responseSchema: REVIEW_RESPONSE_SCHEMA, sampling: { temperature: 0, stream: false }, maxOutputBytes: 512 * 1024, maxOutputTokens: profile.maxOutputTokens, deadlineMs: this.deps.deadlineMs ?? 300000, signal };
    const budget = preflightQualifiedPacket(record, counter, packet, this.deps.safetyTokens ?? 1024);
    if (!manual && budget.imageTokens <= 0) return gate('REVIEW_IMAGE_TOKEN_COUNT_UNQUALIFIED', 'qualified image packet must count every image');
    const response = await invokeBounded(this.deps.transport, packet);
    await snapshot.assertUnchanged();
    const parsed = parseAndValidateStrictJson(response.raw, (value) => ReviewDecisionSchema.parse(value));
    const decision = validateRuntimeDecision(parsed, context);
    await snapshot.assertUnchanged();
    return decision;
  }
}
export const createIntelligenceService = (deps: IntelligenceRuntimeDependencies): IntelligenceService => new RuntimeIntelligenceService(deps);
export { REVIEW_RESPONSE_SCHEMA };
