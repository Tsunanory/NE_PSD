import {
  bundleDigest, canonicalize, JobSpecSchema, ModelProfileSchema, ReviewDecisionSchema, ReviewEvidenceSchema,
  ReviewPolicySchema, sha256Json, type EvidenceBundleManifest, type IntelligenceService, type JobSpec,
  type ModelProfile, type ReviewDecision, type ReviewEvidence, type ReviewPolicy,
} from '@ne-psd/contracts';
import type { ArtifactQaResult } from './artifact-qa.js';
import { verifyEvidenceBundle } from './evidence-bundle.js';

const mandatoryIds = [
  'BINDING.CURRENT_ATTEMPT', 'MANIFEST.COMPLETE', 'ARTIFACTS.EXACTLY_THREE', 'IMAGE.DECODE_FORMAT',
  'IMAGE.DIMENSIONS_COLOR', 'GEOMETRY.REQUESTED_FIT', 'CLIPPING.ALPHA_ADJACENCY', 'VARIANTS.VISIBILITY',
  'SMART_OBJECT.LINEAGE_PROPAGATION', 'SAFETY.LINKED_ISOLATION', 'SAFETY.ORIGINALS_UNCHANGED',
  'SAFETY.DOCUMENT_OWNERSHIP', 'IMAGE.QUALITY', 'VISUAL.QUALIFIED', 'EVIDENCE.TRACE_COMPLETE',
] as const;
const qaAuthoritative = new Set(['ARTIFACTS.EXACTLY_THREE', 'IMAGE.DECODE_FORMAT', 'IMAGE.DIMENSIONS_COLOR', 'IMAGE.QUALITY']);
type RequirementResult = 'pass' | 'fail' | 'unknown';
export type QualifiedProfileRecord = { profile: ModelProfile; qualifiedVision: boolean };
export type ReviewGateInput = {
  bundleRoot: string;
  job: JobSpec;
  evidence: ReviewEvidence;
  manifest: EvidenceBundleManifest;
  policy: ReviewPolicy;
  qa: ArtifactQaResult;
  /** Results from independently validated B proof and persistent A state, never producer assertions alone. */
  validatedProofResults: Readonly<Record<string, RequirementResult>>;
  expectedProfiles: { plannerSha256: string; reviewerSha256: string };
  resolveQualifiedProfile: (profileId: string) => Promise<QualifiedProfileRecord>;
  usedSessionIds: ReadonlySet<string>;
  reviewer: Pick<IntelligenceService, 'review'>;
  signal: AbortSignal;
};
export type ReviewGateResult =
  | { status: 'passed'; decision: ReviewDecision; evidenceSha256: string }
  | { status: 'blocked'; reason: string; evidenceSha256: string }
  | { status: 'pendingReview'; bundleRoot: string; manifest: EvidenceBundleManifest; evidenceSha256: string; reason: string };
export class ReviewGateError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ReviewGateError'; }
}
const fail = (code: string, message: string): never => { throw new ReviewGateError(code, message); };
const expectedIds = new Set<string>(mandatoryIds);

function assertCoverage(input: ReviewGateInput): void {
  const files = new Map(input.manifest.files.map((item) => [item.relativePath, item]));
  const visions = input.manifest.visionInputs;
  if (new Set(visions.map((item) => item.id)).size !== visions.length) fail('VISION_EVIDENCE_MISSING', 'vision input IDs duplicate');
  const source = visions.filter((item) => item.role === 'source');
  const asset = input.job.assets.find((item) => item.assetId === input.manifest.assetId);
  if (source.length !== 1 || source[0]?.sha256 !== asset?.source.sha256 || source[0]?.variantId !== null) fail('VISION_EVIDENCE_MISSING', 'current source vision image missing');
  const role = (path: string, expected: 'renderEvidence' | 'artifact' | 'trace' | 'check' | 'imageInput') => {
    if (files.get(path)?.role !== expected) fail('MANIFEST_INCOMPLETE', `missing ${expected} evidence: ${path}`);
  };
  role('render-evidence.json', 'renderEvidence');
  role(input.evidence.documentTracePath, 'trace');
  role(input.evidence.toolTracePath, 'trace');
  for (const check of input.evidence.checks) role(check.evidencePath, 'check');
  for (const vision of visions) {
    role(vision.relativePath, vision.role === 'output' ? 'artifact' : 'imageInput');
    if (files.get(vision.relativePath)?.sha256 !== vision.sha256) fail('VISION_EVIDENCE_MISSING', 'vision digest differs from file');
  }
  for (const id of ['1', '2', '3'] as const) {
    const artifact = input.evidence.artifacts.find((item) => item.variantId === id);
    const outputs = visions.filter((item) => item.role === 'output' && item.variantId === id);
    const references = visions.filter((item) => item.role === 'reference' && item.variantId === id);
    const details = visions.filter((item) => item.role === 'detail' && item.variantId === id);
    if (!artifact || outputs.length !== 1 || outputs[0]?.relativePath !== artifact.path || outputs[0]?.sha256 !== artifact.sha256
      || references.length !== 1 || details.length === 0 || details.some((item) => item.crop === null || item.derivedFromSha256 !== artifact.sha256))
      fail('VISION_EVIDENCE_MISSING', `reference/output/detail vision evidence incomplete for ${id}`);
  }
  if (input.evidence.schemaVersion === 2) {
    for (const ref of [input.evidence.ownedInputProof, input.evidence.templateClosureProof, input.evidence.releaseProof]) {
      role(ref.relativePath, 'check');
      if (files.get(ref.relativePath)?.sha256 !== ref.sha256) fail('MANIFEST_INCOMPLETE', `V2 proof digest differs: ${ref.relativePath}`);
    }
  }
}

function preflight(input: ReviewGateInput, planner: ModelProfile, reviewer: ModelProfile, qualifiedVision: boolean): void {
  const job = JobSpecSchema.parse(input.job);
  const evidence = ReviewEvidenceSchema.parse(input.evidence);
  const policy = ReviewPolicySchema.parse(input.policy);
  if (policy.visualGate !== 'qualifiedVisionReviewer') fail('VISUAL_GATE_MISMATCH', 'automated review requires qualified vision policy');
  if (policy.policySha256 !== job.reviewPolicySha256 || sha256Json(policy, { excludeKeys: ['policySha256'] }) !== policy.policySha256) fail('POLICY_MISMATCH', 'review policy digest mismatch');
  if (policy.requirements.length !== mandatoryIds.length || new Set(policy.requirements.map((row) => row.id)).size !== mandatoryIds.length
    || policy.requirements.some((row) => !expectedIds.has(row.id) || !row.mandatory || (row.id === 'VISUAL.QUALIFIED' ? row.evaluator !== 'model' : row.evaluator !== 'deterministic'))) fail('POLICY_INCOMPLETE', 'mandatory review requirements incomplete');
  if (planner.profileId !== job.modelProfileId || reviewer.profileId !== job.reviewerModelProfileId
    || sha256Json(planner) !== input.expectedProfiles.plannerSha256 || sha256Json(reviewer) !== input.expectedProfiles.reviewerSha256) fail('PROFILE_MISMATCH', 'selected planner/reviewer profile binding changed');
  if (!qualifiedVision || !reviewer.capabilities.vision || !reviewer.capabilities.jsonSchema) fail('REVIEWER_UNQUALIFIED', 'selected reviewer lacks qualified vision');
  const asset = job.assets.find((item) => item.assetId === evidence.assetId);
  if (!asset) throw new ReviewGateError('ATTEMPT_MISMATCH', 'asset is not in selected job');
  if (input.manifest.jobId !== job.jobId || evidence.jobId !== job.jobId || input.manifest.assetId !== evidence.assetId
    || input.manifest.attempt !== evidence.attempt || evidence.sourceSha256 !== asset.source.sha256
    || evidence.profileSha256 !== job.profile.profileSha256 || evidence.toolSchemaSha256 !== job.profile.toolSchemaSha256) fail('ATTEMPT_MISMATCH', 'job/asset/attempt/source/profile/tool binding changed');
  if (input.qa.bindings.jobId !== job.jobId || input.qa.bindings.assetId !== asset.assetId || input.qa.bindings.attempt !== evidence.attempt
    || input.qa.bindings.profileSha256 !== job.profile.profileSha256 || input.qa.bindings.sourceSha256 !== asset.source.sha256
    || input.qa.bindings.toolSchemaSha256 !== job.profile.toolSchemaSha256 || input.qa.bindings.reviewPolicySha256 !== policy.policySha256) fail('QA_BINDING_MISMATCH', 'artifact QA belongs to another transaction');
  if (!input.qa.artifactChecksPassed || input.qa.artifacts.length !== 3 || evidence.artifacts.length !== 3) fail('ARTIFACT_SET_INVALID', 'three verified artifact outputs required');
  for (const [index, id] of (['1', '2', '3'] as const).entries()) {
    const actual = evidence.artifacts[index]; const checked = input.qa.artifacts[index];
    if (!actual || !checked) throw new ReviewGateError('ARTIFACT_BINDING_MISMATCH', `variant ${id} missing`);
    if (actual.variantId !== id || checked.variantId !== id || actual.path !== checked.path || actual.sha256 !== checked.sha256 || actual.bytes !== checked.bytes) fail('ARTIFACT_BINDING_MISMATCH', `variant ${id} differs from independent QA`);
    const manifestFile = input.manifest.files.find((item) => item.relativePath === actual.path);
    if (!manifestFile || manifestFile.role !== 'artifact' || manifestFile.sha256 !== actual.sha256 || manifestFile.bytes !== actual.bytes) fail('MANIFEST_ARTIFACT_MISMATCH', `variant ${id} absent from manifest`);
  }
}

function deterministicBlock(input: ReviewGateInput): string | null {
  for (const id of mandatoryIds) {
    if (id === 'VISUAL.QUALIFIED' || id === 'MANIFEST.COMPLETE') continue;
    const qaResult = input.qa.requirementResults[id as keyof ArtifactQaResult['requirementResults']] as RequirementResult | undefined;
    const result = qaAuthoritative.has(id) ? qaResult : input.validatedProofResults[id];
    if (result !== 'pass') return `${id} is ${result ?? 'unknown'}`;
  }
  return null;
}

function validateDecision(input: ReviewGateInput, decision: ReviewDecision, evidenceSha256: string, reviewer: ModelProfile): ReviewGateResult {
  const parsed = ReviewDecisionSchema.parse(decision);
  if (parsed.jobId !== input.job.jobId || parsed.assetId !== input.manifest.assetId || parsed.attempt !== input.manifest.attempt
    || parsed.evidenceSha256 !== evidenceSha256 || parsed.reviewPolicySha256 !== input.policy.policySha256 || parsed.promptSha256 !== input.policy.promptSha256
    || parsed.modelId !== reviewer.modelId || canonicalize(parsed.modelProvenance) !== canonicalize(reviewer.provenance)) fail('DECISION_BINDING_MISMATCH', 'review response binding differs from selected evidence, prompt, policy or model');
  if (input.usedSessionIds.has(parsed.sessionId)) fail('REVIEW_SESSION_REUSED', 'review session was previously used');
  const checks = new Map(parsed.checks.map((check) => [check.requirementId, check]));
  if (checks.size !== mandatoryIds.length || parsed.checks.length !== mandatoryIds.length || [...checks.keys()].some((id) => !expectedIds.has(id))) fail('DECISION_CHECK_SET_INVALID', 'review response lacks mandatory coverage');
  const known = new Set(input.manifest.files.map((file) => file.relativePath));
  const refs = [...parsed.checks.flatMap((check) => check.evidenceRefs), ...parsed.variantChecks.flatMap((check) => check.evidenceRefs), ...parsed.findings.flatMap((finding) => finding.evidenceRefs)];
  if (refs.some((ref) => !known.has(ref))) fail('DECISION_REFERENCE_INVALID', 'review cited unsealed evidence');
  for (const [index, id] of (['1', '2', '3'] as const).entries()) {
    const variant = parsed.variantChecks[index];
    const output = input.evidence.artifacts[index];
    if (variant?.variantId !== id || !variant.evidenceRefs.includes(output!.path) || !variant.reason.trim()) fail('DECISION_VARIANT_INVALID', `variant ${id} lacks its own evidence`);
  }
  if (parsed.verdict === 'pass' && (parsed.checks.some((check) => check.result !== 'pass') || parsed.variantChecks.some((variant) => variant.verdict !== 'pass')
    || parsed.findings.some((finding) => finding.severity === 'critical' || finding.severity === 'major'))) fail('FALSE_PASS', 'aggregate pass contradicts mandatory check or variant failure');
  for (const id of mandatoryIds) if (id !== 'VISUAL.QUALIFIED' && checks.get(id)?.result !== 'pass' && parsed.verdict === 'pass') fail('DETERMINISTIC_OVERRIDE', `${id} was not passed`);
  if (parsed.verdict !== 'pass') return { status: 'blocked', reason: `review verdict ${parsed.verdict}`, evidenceSha256 };
  return { status: 'passed', decision: parsed, evidenceSha256 };
}

export async function gateAutomatedReview(input: ReviewGateInput): Promise<ReviewGateResult> {
  const plannerRecord = await input.resolveQualifiedProfile(input.job.modelProfileId);
  const reviewerRecord = await input.resolveQualifiedProfile(input.job.reviewerModelProfileId);
  const planner = ModelProfileSchema.parse(plannerRecord.profile);
  const reviewer = ModelProfileSchema.parse(reviewerRecord.profile);
  preflight(input, planner, reviewer, reviewerRecord.qualifiedVision);
  assertCoverage(input);
  await verifyEvidenceBundle(input.bundleRoot, input.manifest);
  const evidenceSha256 = bundleDigest(input.manifest);
  const boundState = canonicalize({ job: input.job, evidence: input.evidence, manifest: input.manifest, policy: input.policy, qa: input.qa });
  const assertBoundState = () => {
    if (canonicalize({ job: input.job, evidence: input.evidence, manifest: input.manifest, policy: input.policy, qa: input.qa }) !== boundState
      || bundleDigest(input.manifest) !== evidenceSha256) fail('REVIEW_INPUT_DRIFT', 'review input changed during inference');
  };
  const block = deterministicBlock(input);
  if (block) return { status: 'blocked', reason: block, evidenceSha256 };
  let decision: ReviewDecision;
  try {
    decision = await input.reviewer.review({ evidence: input.evidence, manifest: input.manifest, policy: input.policy }, reviewer.profileId, input.signal);
  } catch (error) {
    await verifyEvidenceBundle(input.bundleRoot, input.manifest);
    assertBoundState();
    return { status: 'pendingReview', bundleRoot: input.bundleRoot, manifest: input.manifest, evidenceSha256,
      reason: error instanceof Error ? error.message : 'reviewer unavailable' };
  }
  await verifyEvidenceBundle(input.bundleRoot, input.manifest);
  assertBoundState();
  return validateDecision(input, decision, evidenceSha256, reviewer);
}
