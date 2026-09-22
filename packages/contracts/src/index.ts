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

function safeAbsolutePath(value: string): boolean {
 return (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) && !value.split(/[\\/]/).includes('..');
}

const REQUIREMENT_IDS = [
 'BINDING.CURRENT_ATTEMPT', 'MANIFEST.COMPLETE', 'ARTIFACTS.EXACTLY_THREE', 'IMAGE.DECODE_FORMAT',
 'IMAGE.DIMENSIONS_COLOR', 'GEOMETRY.REQUESTED_FIT', 'CLIPPING.ALPHA_ADJACENCY', 'VARIANTS.VISIBILITY',
 'SMART_OBJECT.LINEAGE_PROPAGATION', 'SAFETY.LINKED_ISOLATION', 'SAFETY.ORIGINALS_UNCHANGED',
 'SAFETY.DOCUMENT_OWNERSHIP', 'IMAGE.QUALITY', 'VISUAL.QUALIFIED', 'EVIDENCE.TRACE_COMPLETE',
] as const;

export function validateConfigurationProposal(proposal: ConfigurationProposal, inspection: InspectionReport) {
  const parsed = ConfigurationProposalSchema.safeParse(proposal);
  if (!parsed.success) return { success: false as const, error: parsed.error };
  if (parsed.data.inspectionId !== inspection.inspectionId) return { success: false as const, error: new Error('proposal inspection mismatch') };
 const candidates = new Set(inspection.candidates.map((candidate) => candidate.candidateId));
 for (const target of parsed.data.targets) {
  const targetCandidate = inspection.candidates.find((candidate) => candidate.candidateId === target.targetCandidateId);
  const referenceCandidate = inspection.candidates.find((candidate) => candidate.candidateId === target.referenceCandidateId);
  const inputCandidate = target.inputCandidateId === null ? null : inspection.candidates.find((candidate) => candidate.candidateId === target.inputCandidateId);
  if (!candidates.has(target.targetCandidateId) || !candidates.has(target.referenceCandidateId) || (target.inputCandidateId !== null && !candidates.has(target.inputCandidateId))) return { success: false as const, error: new Error('proposal references unknown candidate') };
  if (!targetCandidate?.roleHints.includes('target') || !referenceCandidate?.roleHints.includes('reference')) return { success: false as const, error: new Error('proposal candidate roles are incompatible') };
  if (inputCandidate !== null && !inputCandidate?.roleHints.includes('input')) return { success: false as const, error: new Error('proposal input role is incompatible') };
  if (targetCandidate.documentKey !== referenceCandidate.documentKey || (inputCandidate !== null && inputCandidate.documentKey !== targetCandidate.documentKey)) return { success: false as const, error: new Error('proposal document routes are incompatible') };
 }
 const targetDocumentKey = inspection.candidates.find((candidate) => candidate.candidateId === parsed.data.targets[0]?.targetCandidateId)?.documentKey;
 for (const variant of parsed.data.variants) {
  const candidate = inspection.candidates.find((entry) => entry.candidateId === variant.groupCandidateId);
  if (!candidate || !candidate.roleHints.includes('variant') || candidate.documentKey !== targetDocumentKey) return { success: false as const, error: new Error('proposal variant role or document route is incompatible') };
 }
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
  if (!safeAbsolutePath(parsed.data.workingTemplatePath) || !safeAbsolutePath(parsed.data.evidenceDirectory)) return { success: false as const, error: new Error('qualification paths must be safe absolute paths') };
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
    if (parsed.data.candidate.template.rootId !== request.inspection.template.rootId || parsed.data.candidate.template.relativePath !== request.inspection.template.relativePath) return { success: false as const, error: new Error('qualified candidate source binding mismatch') };
    if (parsed.data.candidate.backendId !== capabilities.backendId || parsed.data.candidate.toolSchemaSha256 !== capabilities.toolSchemaSha256) return { success: false as const, error: new Error('qualified candidate backend or tool schema mismatch') };
    if (!capabilities.supportedFitModes.includes(parsed.data.candidate.fitMode)) return { success: false as const, error: new Error('qualified candidate fit mode is unsupported') };
    if (request.proposal.output === null || parsed.data.candidate.fitMode !== request.proposal.fitMode || parsed.data.candidate.output.width !== request.proposal.output.width || parsed.data.candidate.output.height !== request.proposal.output.height || parsed.data.candidate.output.format !== request.proposal.output.format) return { success: false as const, error: new Error('qualified candidate proposal binding mismatch') };
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

export type ReviewValidationContext = { attempt?: number; jobId?: string; assetId?: string; reviewerModelProfileId?: string; requiredEvidenceRefs?: readonly string[] };
export function validateReviewDecision(review: ReviewDecision, expectedPolicySha256: string, context?: ReviewValidationContext) {
  const parsed = ReviewDecisionSchema.safeParse(review);
  if (!parsed.success) return { success: false as const, error: parsed.error };
  if (parsed.data.reviewPolicySha256 !== expectedPolicySha256) return { success: false as const, error: new Error('review policy digest mismatch') };
  const ids = parsed.data.checks.map((check) => check.requirementId);
  if (new Set(ids).size !== REQUIREMENT_IDS.length || ids.some((id) => !REQUIREMENT_IDS.includes(id as typeof REQUIREMENT_IDS[number])) || REQUIREMENT_IDS.some((id) => !ids.includes(id))) return { success: false as const, error: new Error('review requirements must be the exact registry') };
  if (context?.attempt !== undefined && parsed.data.attempt !== context.attempt) return { success: false as const, error: new Error('review attempt binding mismatch') };
  if (context?.jobId !== undefined && parsed.data.jobId !== context.jobId) return { success: false as const, error: new Error('review job binding mismatch') };
  if (context?.assetId !== undefined && parsed.data.assetId !== context.assetId) return { success: false as const, error: new Error('review asset binding mismatch') };
  if (context?.reviewerModelProfileId !== undefined && parsed.data.modelId !== context.reviewerModelProfileId) return { success: false as const, error: new Error('reviewer model binding mismatch') };
  if (context?.requiredEvidenceRefs?.some((required) => !parsed.data.checks.some((check) => check.evidenceRefs.includes(required)))) return { success: false as const, error: new Error('review required evidence is incomplete') };
  return { success: true as const, data: parsed.data };
}
