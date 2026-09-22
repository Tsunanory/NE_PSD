export const FOUNDATION_SCHEMA_VERSION = 1 as const;

export type FoundationPackage = {
  packageName: string;
  schemaVersion: typeof FOUNDATION_SCHEMA_VERSION;
};

export function foundationPackage(packageName: string): FoundationPackage {
  return { packageName, schemaVersion: FOUNDATION_SCHEMA_VERSION };
}

export * from './domain.js';
export * from './models.js';
export * from './inspection.js';
export * from './review.js';
export * from './errors.js';
export * from './services.js';
export * from './canonicalize.js';

export { QualificationRequestSchema, QualificationResultSchema, TemplateCandidateSchema } from './models.js';
export type { QualificationRequest, QualificationResult, TemplateCandidate } from './models.js';

import {
  ConfigurationProposalSchema,
  InspectionReportSchema,
  JobSpecSchema,
  ModelProfileSchema,
  ReviewDecisionSchema,
  TemplateProfileSchema,
} from './domain.js';
import { QualificationRequestSchema, QualificationResultSchema, TemplateCandidateSchema } from './models.js';
import type { ConfigurationProposal, InspectionReport, JobSpec, ModelProfile, ReviewDecision } from './domain.js';
import type { QualificationResult, QualificationRequest } from './models.js';

function containsTestOnlyPath(paths: readonly string[]): boolean {
  return paths.some((path) => path === 'testOnly' || path.startsWith('testOnly/'));
}

export function validateConfigurationProposal(proposal: ConfigurationProposal, inspection: InspectionReport) {
  const parsed = ConfigurationProposalSchema.safeParse(proposal);
  if (!parsed.success) return { success: false as const, error: parsed.error };
  if (parsed.data.inspectionId !== inspection.inspectionId) return { success: false as const, error: new Error('proposal inspection mismatch') };
  const candidates = new Set(inspection.candidates.map((candidate) => candidate.candidateId));
  for (const target of parsed.data.targets) {
    if (!candidates.has(target.targetCandidateId) || !candidates.has(target.referenceCandidateId) || (target.inputCandidateId !== null && !candidates.has(target.inputCandidateId))) return { success: false as const, error: new Error('proposal references unknown candidate') };
  }
  for (const variant of parsed.data.variants) if (!candidates.has(variant.groupCandidateId)) return { success: false as const, error: new Error('proposal references unknown variant candidate') };
  const evidence = new Set(inspection.evidencePaths);
  if (parsed.data.facts.some((fact) => fact.evidenceRefs.some((ref) => !evidence.has(ref)))) return { success: false as const, error: new Error('proposal references unknown evidence') };
  return { success: true as const, data: parsed.data };
}

export function validateQualificationRequest(request: unknown) {
  const parsed = QualificationRequestSchema.safeParse(request);
  if (!parsed.success) return { success: false as const, error: parsed.error };
  const validated = validateConfigurationProposal(parsed.data.proposal, parsed.data.inspection);
  if (!validated.success) return validated;
  const evidencePaths = [
    ...parsed.data.inspection.evidencePaths,
    ...(parsed.data.inspection.capabilities?.evidencePaths ?? []),
    ...parsed.data.proposal.facts.flatMap((fact) => fact.evidenceRefs),
  ];
  if (containsTestOnlyPath(evidencePaths)) return { success: false as const, error: new Error('test-only evidence cannot qualify a live template') };
  if (parsed.data.inspection.evidenceStatus !== 'liveObserved' || parsed.data.inspection.capabilities === null) return { success: false as const, error: new Error('qualification requires live inspection and capabilities') };
  return { success: true as const, data: parsed.data };
}

export function validateQualificationResult(result: unknown, request: QualificationRequest) {
  const parsed = QualificationResultSchema.safeParse(result);
  if (!parsed.success) return { success: false as const, error: parsed.error };
  if (containsTestOnlyPath([...parsed.data.evidencePaths, ...parsed.data.checks.map((check) => check.evidencePath)])) return { success: false as const, error: new Error('test-only evidence cannot qualify a live template') };
  const validatedRequest = validateQualificationRequest(request);
  if (!validatedRequest.success) return validatedRequest;
  const capabilities = request.inspection.capabilities;
  if (capabilities === null) return { success: false as const, error: new Error('qualification requires capabilities') };
  if (parsed.data.status === 'qualified' && parsed.data.candidate !== null) {
    if (parsed.data.candidate.template.sha256 !== request.inspection.template.sha256) return { success: false as const, error: new Error('qualified candidate source hash mismatch') };
    if (parsed.data.candidate.backendId !== capabilities.backendId) return { success: false as const, error: new Error('qualified candidate backend mismatch') };
    if (!capabilities.supportedFitModes.includes(parsed.data.candidate.fitMode)) return { success: false as const, error: new Error('qualified candidate fit mode is unsupported') };
  }
  return { success: true as const, data: parsed.data };
}

export function validateModelProfile(profile: unknown) {
  return ModelProfileSchema.safeParse(profile);
}

export function validateJobSpec(spec: unknown, modelProfile?: unknown) {
  const parsed = JobSpecSchema.safeParse(spec);
  if (!parsed.success) return { success: false as const, error: parsed.error };
  if (modelProfile !== undefined) {
    const model = ModelProfileSchema.safeParse(modelProfile);
    if (!model.success) return { success: false as const, error: model.error };
    if (parsed.data.trigger === 'scheduled' && model.data.provider === 'local-qwen') return { success: false as const, error: new Error('local Qwen jobs cannot be scheduled') };
    if (model.data.profileId !== parsed.data.modelProfileId && model.data.profileId !== parsed.data.reviewerModelProfileId) return { success: false as const, error: new Error('model profile is not bound to job') };
  }
  return { success: true as const, data: parsed.data };
}

export function validateReviewDecision(review: ReviewDecision, expectedPolicySha256: string) {
  const parsed = ReviewDecisionSchema.safeParse(review);
  if (!parsed.success) return { success: false as const, error: parsed.error };
  if (parsed.data.reviewPolicySha256 !== expectedPolicySha256) return { success: false as const, error: new Error('review policy digest mismatch') };
  return { success: true as const, data: parsed.data };
}
