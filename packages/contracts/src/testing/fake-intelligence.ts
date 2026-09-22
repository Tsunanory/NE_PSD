import {
  ConfigurationProposalSchema,
  EvidenceBundleManifestSchema,
  ModelProfileSchema,
  ReviewDecisionSchema,
  RenderEvidenceSchema,
  ReviewPolicySchema,
  type ConfigurationProposal,
  type DomainError,
  type EvidenceBundleManifest,
  type InspectionReport,
  type ModelProfile,
  type RenderEvidence,
  type ReviewDecision,
  type ReviewPolicy,
} from '../index.js';
import { sha256Json } from '../canonicalize.js';
import type { IntelligenceService } from '../services.js';
import {
  FakeFailureError,
  type FakeConfig,
  fixtureRoot,
  fixedClock,
  loadFixture,
  RUNTIME_REQUIREMENT_IDS,
  testOnlyPath,
} from './fixture-loader.js';

export type FakeIntelligenceMode = 'pass' | 'revise' | 'blocked' | 'invalidJson';
export type FakeIntelligenceOptions = FakeConfig & {
  readonly mode?: FakeIntelligenceMode;
  readonly fixtureRoot?: string;
};

export class FakeIntelligence implements IntelligenceService {
  readonly testOnly = true as const;
  readonly mode: FakeIntelligenceMode;
  readonly clock;
  readonly fixtureRootPath: string;
  lastRawResponse = '';

  constructor(options: FakeIntelligenceOptions = {}) {
    this.mode = options.mode ?? 'pass';
    this.clock = options.clock ?? fixedClock();
    this.fixtureRootPath = options.fixtureRoot ?? fixtureRoot();
  }

  async propose(input: { instruction: string; inspection: InspectionReport; modelProfileId: string }, signal: AbortSignal): Promise<ConfigurationProposal> {
    this.throwIfAborted(signal);
    if (this.mode === 'invalidJson') return this.invalidJson();
    const fixture = loadFixture<ConfigurationProposal>('proposal.valid.json', this.fixtureRootPath);
    if (fixture.inspectionId !== input.inspection.inspectionId) {
      return ConfigurationProposalSchema.parse({
        ...fixture,
        inspectionId: input.inspection.inspectionId,
        facts: fixture.facts.map((fact) => ({ ...fact, evidenceRefs: fact.evidenceRefs.map(testOnlyPath) })),
      });
    }
    return ConfigurationProposalSchema.parse({
      ...fixture,
      facts: fixture.facts.map((fact) => ({ ...fact, evidenceRefs: fact.evidenceRefs.map(testOnlyPath) })),
    });
  }

  async review(input: { evidence: RenderEvidence; manifest: EvidenceBundleManifest; policy: ReviewPolicy }, modelProfileId: string, signal: AbortSignal): Promise<ReviewDecision> {
    this.throwIfAborted(signal);
    if (this.mode === 'invalidJson') return this.invalidJson();
    const evidence = RenderEvidenceSchema.parse(input.evidence);
    const manifest = EvidenceBundleManifestSchema.parse(input.manifest);
    const policy = ReviewPolicySchema.parse(input.policy);
    this.validateReviewInputs(evidence, manifest, policy);
    const verdict = this.mode === 'pass' ? 'pass' : this.mode;
    const variantVerdict = this.mode === 'pass' ? 'pass' : this.mode === 'revise' ? 'fail' : 'unknown';
    const artifactRefs = input.evidence.artifacts.map((artifact) => artifact.path);
    const checks = RUNTIME_REQUIREMENT_IDS.map((requirementId) => ({
      requirementId,
      result: this.mode === 'pass' ? 'pass' as const : this.mode === 'revise' && requirementId === 'IMAGE.QUALITY' ? 'fail' as const : 'unknown' as const,
      evidenceRefs: artifactRefs,
      reason: this.mode === 'pass' ? 'fixture evidence satisfies the fake check' : `fixture mode ${this.mode}`,
    }));
    const decision: ReviewDecision = ReviewDecisionSchema.parse({
      schemaVersion: 1,
      reviewId: `testOnly/review/${input.evidence.jobId}/${input.evidence.assetId}/attempt-${input.evidence.attempt}`,
      jobId: input.evidence.jobId,
      assetId: input.evidence.assetId,
      attempt: input.evidence.attempt,
      evidenceSha256: sha256Json({ evidence: input.evidence, manifest: input.manifest }),
      sessionId: `testOnly/session/${this.clock.now().toISOString()}`,
      promptSha256: input.policy.promptSha256,
      modelId: modelProfileId,
      modelProvenance: {
        kind: 'remote',
        provider: 'luna',
        modelId: modelProfileId,
        revision: null,
        qualificationEvidencePath: 'testOnly/model/fixture.json',
      },
      reviewerVersion: 'testOnly/fake-reviewer-v1',
      reviewPolicySha256: input.policy.policySha256,
      verdict,
      variantChecks: (['1', '2', '3'] as const).map((variantId, index) => ({
        variantId,
        verdict: variantVerdict,
        evidenceRefs: artifactRefs[index] === undefined ? [] : [artifactRefs[index]],
        reason: this.mode === 'pass' ? `fixture variant ${variantId} passes` : `fixture mode ${this.mode} for variant ${variantId}`,
      })),
      checks,
      findings: this.mode === 'pass' ? [] : [{
        severity: this.mode === 'revise' ? 'major' as const : 'critical' as const,
        code: `TEST_ONLY_${this.mode.toUpperCase()}`,
        evidenceRefs: artifactRefs,
        message: `fake intelligence returned ${this.mode}`,
      }],
    });
    this.lastRawResponse = JSON.stringify(decision);
    return decision;
  }

  async inspectModelProfile(profile: ModelProfile, signal: AbortSignal): Promise<{ available: boolean; errors: DomainError[] }> {
    this.throwIfAborted(signal);
    const parsed = ModelProfileSchema.safeParse(profile);
    if (!parsed.success) return { available: false, errors: [this.error('INVALID_MODEL_PROFILE', 'validation', parsed.error.message, false)] };
    return { available: true, errors: [] };
  }

  async qualifyModelProfile(profile: ModelProfile, signal: AbortSignal): Promise<{ qualified: boolean; evidencePaths: string[]; errors: DomainError[] }> {
    this.throwIfAborted(signal);
    const availability = await this.inspectModelProfile(profile, signal);
    return {
      qualified: availability.available,
      evidencePaths: availability.available ? ['testOnly/model/qualification.json'] : [],
      errors: availability.errors,
    };
  }

  private invalidJson<T>(): T {
    this.lastRawResponse = '{"verdict":"pass"';
    throw new FakeFailureError('invalidJson', 'fake intelligence returned invalid JSON');
  }

  private validateReviewInputs(evidence: RenderEvidence, manifest: EvidenceBundleManifest, policy: ReviewPolicy): void {
    if (evidence.jobId !== manifest.jobId || evidence.assetId !== manifest.assetId || evidence.attempt !== manifest.attempt) throw new FakeFailureError('reviewContract', 'evidence and manifest binding mismatch');
    if (policy.requirements.length !== RUNTIME_REQUIREMENT_IDS.length || policy.requirements.some((requirement, index) => requirement.id !== RUNTIME_REQUIREMENT_IDS[index] || !requirement.mandatory)) throw new FakeFailureError('reviewContract', 'review policy requirement registry mismatch');
    if (evidence.artifacts.length !== 3 || evidence.artifacts.map((artifact) => artifact.variantId).join(',') !== '1,2,3') throw new FakeFailureError('reviewContract', 'review requires exactly three ordered artifacts');
    const files = new Map(manifest.files.map((file) => [file.relativePath, file]));
    for (const artifact of evidence.artifacts) {
      const file = files.get(artifact.path);
      if (file === undefined || file.role !== 'artifact' || file.sha256 !== artifact.sha256 || file.bytes !== artifact.bytes) throw new FakeFailureError('reviewContract', 'manifest does not close over artifacts');
    }
    for (const path of [evidence.documentTracePath, evidence.toolTracePath, ...evidence.checks.map((check) => check.evidencePath)]) {
      if (!files.has(path)) throw new FakeFailureError('reviewContract', `manifest missing evidence ${path}`);
    }
  }

  private error(code: string, category: DomainError['category'], message: string, retryable: boolean): DomainError {
    return { code, category, message, retryable, evidencePaths: ['testOnly/model/errors.json'] };
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new DOMException('The operation was aborted', 'AbortError');
  }
}

export function createFakeIntelligence(options: FakeIntelligenceOptions = {}): FakeIntelligence {
  return new FakeIntelligence(options);
}
