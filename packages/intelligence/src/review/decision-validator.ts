import { ReviewDecisionSchema, type EvidenceBundleManifest, type JobSpec, type ModelProfile, type RenderEvidence, type ReviewDecision, type ReviewPolicy } from '@ne-psd/contracts';
import { canonicalize } from '@ne-psd/contracts';
import { MANDATORY_REQUIREMENTS, policyDigest } from './requirements.js';

export class ReviewGateError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ReviewGateError'; }
}
export type ReviewContext = {
  job: JobSpec; manifest: EvidenceBundleManifest; evidence: RenderEvidence; policy: ReviewPolicy; evidenceSha256: string;
  profile: ModelProfile; sessionId: string; reviewId: string; promptSha256: string; reviewerVersion: string;
  imageQualityPassed: boolean; attestationPassed: boolean; safeCleanup: boolean; admissibleCorrections: readonly string[];
};
const fail = (code: string, message: string): never => { throw new ReviewGateError(code, message); };
const hostChecks = new Set(['BINDING.CURRENT_ATTEMPT', 'MANIFEST.COMPLETE', 'ARTIFACTS.EXACTLY_THREE', 'IMAGE.DECODE_FORMAT', 'IMAGE.DIMENSIONS_COLOR', 'IMAGE.QUALITY', 'EVIDENCE.TRACE_COMPLETE']);
export const QUALIFIED_REVIEW_CORRECTIONS = ['REAPPLY_APPROVED_CONFIGURATION'] as const;

/** Rejects incomplete deterministic evidence before model inference. */
export function assertDeterministicReviewEvidence(context: ReviewContext): void {
  const { job, manifest, evidence, policy } = context;
  if (policyDigest(policy) !== policy.policySha256 || policy.policySha256 !== job.reviewPolicySha256 || policy.promptSha256 !== context.promptSha256) fail('REVIEW_POLICY_MISMATCH', 'review policy or prompt is not bound to job');
  const expectedRequirements = MANDATORY_REQUIREMENTS.map((row) => ({ ...row, evaluator: row.id === 'VISUAL.QUALIFIED' && policy.visualGate === 'humanPerAsset' ? 'human' : row.evaluator }));
  if (canonicalize(policy.requirements) !== canonicalize(expectedRequirements)) fail('REVIEW_POLICY_REQUIREMENTS_INVALID', 'policy must contain the frozen 15 mandatory requirements');
  if (manifest.jobId !== job.jobId || evidence.jobId !== job.jobId || manifest.assetId !== evidence.assetId || manifest.attempt !== evidence.attempt || !job.assets.some((asset) => asset.assetId === evidence.assetId)) fail('REVIEW_SUBJECT_MISMATCH', 'persisted job, manifest and render evidence disagree');
  if (job.reviewerModelProfileId !== context.profile.profileId || context.profile.modelId.length === 0) fail('REVIEW_PROFILE_MISMATCH', 'reviewer profile is not selected in persisted job');
  if (!context.imageQualityPassed) fail('REVIEW_IMAGE_QUALITY_FAILED', 'deterministic image quality gate failed');
  if (policy.visualGate === 'humanPerAsset' && !context.attestationPassed) fail('REVIEW_ATTESTATION_MISSING', 'current consumed human attestation is required');
  const variantIds = evidence.artifacts.map((artifact) => artifact.variantId);
  if (variantIds.join(',') !== '1,2,3' || manifest.files.filter((file) => file.role === 'artifact').length !== 3) fail('REVIEW_ARTIFACT_SET_INVALID', 'exactly three current variant artifacts are required');
  const filePaths = new Set(manifest.files.map((file) => file.relativePath));
  const checks = new Map(evidence.checks.map((check) => [check.id, check]));
  for (const requirement of MANDATORY_REQUIREMENTS) {
    if (requirement.id === 'VISUAL.QUALIFIED' || hostChecks.has(requirement.id)) continue;
    const check = checks.get(requirement.id);
    if (!check?.evidencePath || !filePaths.has(check.evidencePath)) fail('REVIEW_DETERMINISTIC_EVIDENCE_MISSING', `missing or unlisted report for ${requirement.id}`);
    if (check?.passed !== true) fail('REVIEW_DETERMINISTIC_CHECK_FAILED', `deterministic check failed: ${requirement.id}`);
  }
  for (const artifact of evidence.artifacts) if (!filePaths.has(artifact.path)) fail('REVIEW_ARTIFACT_UNLISTED', 'artifact is absent from sealed manifest');
}

export function validateRuntimeDecision(input: unknown, context: ReviewContext): ReviewDecision {
  const parsed = ReviewDecisionSchema.safeParse(input);
  if (!parsed.success) return fail('REVIEW_MODEL_OUTPUT_INVALID', parsed.error.message);
  const decision = parsed.data;
  assertDeterministicReviewEvidence(context);
  if (decision.reviewId !== context.reviewId || decision.jobId !== context.job.jobId || decision.assetId !== context.evidence.assetId || decision.attempt !== context.evidence.attempt || decision.evidenceSha256 !== context.evidenceSha256 || decision.sessionId !== context.sessionId || decision.promptSha256 !== context.promptSha256 || decision.reviewerVersion !== context.reviewerVersion || decision.reviewPolicySha256 !== context.policy.policySha256 || decision.modelId !== context.profile.modelId || canonicalize(decision.modelProvenance) !== canonicalize(context.profile.provenance)) fail('REVIEW_BINDING_MISMATCH', 'review response does not bind current session, model, policy and sealed evidence');
  const required = new Set<string>(MANDATORY_REQUIREMENTS.map((row) => row.id));
  const actual = decision.checks.map((check) => check.requirementId);
  if (actual.length !== required.size || new Set(actual).size !== required.size || actual.some((id) => !required.has(id))) fail('REVIEW_CHECK_SET_INVALID', 'all 15 mandatory checks must appear exactly once');
  const knownFiles = new Set(context.manifest.files.map((file) => file.relativePath));
  const refs = [...decision.checks.flatMap((check) => check.evidenceRefs), ...decision.variantChecks.flatMap((check) => check.evidenceRefs), ...decision.findings.flatMap((finding) => finding.evidenceRefs)];
  if (refs.some((ref) => !knownFiles.has(ref))) fail('REVIEW_REFERENCE_UNKNOWN', 'review cited evidence outside sealed manifest');
  for (const [index, variant] of decision.variantChecks.entries()) {
    const id = String(index + 1);
    const artifact = context.evidence.artifacts[index];
    if (variant.variantId !== id || artifact?.variantId !== id || !variant.evidenceRefs.includes(artifact.path) || variant.reason.trim().length === 0) fail('REVIEW_VARIANT_BINDING_INVALID', `variant ${id} requires its own image and factual reason`);
    if (variant.verdict === 'pass' && context.policy.visualGate === 'qualifiedVisionReviewer') {
      const source = context.manifest.visionInputs.find((image) => image.role === 'source');
      const reference = context.manifest.visionInputs.find((image) => image.role === 'reference' && image.variantId === id);
      const details = context.manifest.visionInputs.filter((image) => image.role === 'detail' && image.variantId === id);
      if (!source || !reference || details.length === 0 || !variant.evidenceRefs.includes(source.relativePath) ||
          !variant.evidenceRefs.includes(reference.relativePath) || !details.some((image) => variant.evidenceRefs.includes(image.relativePath)))
        fail('REVIEW_VARIANT_VISUAL_REFS_MISSING', `variant ${id} pass requires current source, reference and detail image citations`);
    }
    if (variant.verdict === 'pass' && context.policy.visualGate === 'humanPerAsset' &&
        !context.manifest.files.some((file) => file.role === 'humanAttestation' && variant.evidenceRefs.includes(file.relativePath)))
      fail('REVIEW_VARIANT_ATTESTATION_REF_MISSING', `variant ${id} pass requires current human attestation citation`);
  }
  const checksById = new Map(decision.checks.map((check) => [check.requirementId, check]));
  for (const id of hostChecks) if (checksById.get(id)?.result !== 'pass') fail('REVIEW_HOST_CHECK_CONTRADICTION', `model contradicted deterministic result for ${id}`);
  if (context.policy.visualGate === 'humanPerAsset' && checksById.get('VISUAL.QUALIFIED')?.result !== 'pass') fail('REVIEW_VISUAL_GATE_CONTRADICTION', 'human attestation gate is not represented as pass');
  if (decision.verdict === 'pass' && (decision.checks.some((check) => check.result !== 'pass') || decision.variantChecks.some((check) => check.verdict !== 'pass') || decision.findings.some((finding) => finding.severity === 'critical' || finding.severity === 'major'))) fail('REVIEW_FALSE_PASS', 'aggregate pass contradicts required checks, variants or severe findings');
  if (decision.verdict === 'revise' && (context.evidence.attempt !== 1 || !context.safeCleanup || !decision.findings.some((finding) => QUALIFIED_REVIEW_CORRECTIONS.some((code) => code === finding.code) && context.admissibleCorrections.includes(finding.code)))) fail('REVIEW_REVISION_UNQUALIFIED', 'revision requires attempt one, proven cleanup and a cause-bound coordinator-approved correction');
  return decision;
}
