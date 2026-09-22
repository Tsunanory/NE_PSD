import type {
  CapabilityReport,
  ConfigurationProposal,
  DomainError,
  EvidenceBundleManifest,
  InspectionReport,
  JobEvent,
  JobSnapshot,
  JobSpec,
  ModelProfile,
  QualificationRequest,
  QualificationResult,
  RenderEvidence,
  RenderRequest,
  ReviewDecision,
  ReviewPolicy,
  TemplateProfile,
  VisualReviewRequest,
} from './index.js';

export interface PhotoshopBackend {
  capabilities(signal: AbortSignal): Promise<CapabilityReport>;
  inspect(templatePath: string, signal: AbortSignal): Promise<InspectionReport>;
  qualify(request: QualificationRequest, signal: AbortSignal): Promise<QualificationResult>;
  render(request: RenderRequest, signal: AbortSignal): Promise<RenderEvidence>;
  recover(jobId: string, signal: AbortSignal): Promise<{ safe: boolean; evidencePaths: string[] }>;
}

export interface IntelligenceService {
  propose(input: { instruction: string; inspection: InspectionReport; modelProfileId: string }, signal: AbortSignal): Promise<ConfigurationProposal>;
  review(input: { evidence: RenderEvidence; manifest: EvidenceBundleManifest; policy: ReviewPolicy }, modelProfileId: string, signal: AbortSignal): Promise<ReviewDecision>;
  inspectModelProfile(profile: ModelProfile, signal: AbortSignal): Promise<{ available: boolean; errors: DomainError[] }>;
  qualifyModelProfile(profile: ModelProfile, signal: AbortSignal): Promise<{ qualified: boolean; evidencePaths: string[]; errors: DomainError[] }>;
}

export interface SetupService {
  inspectTemplate(templatePath: string, signal: AbortSignal): Promise<InspectionReport>;
  proposeConfiguration(input: { instruction: string; inspectionId: string; modelProfileId: string }, signal: AbortSignal): Promise<ConfigurationProposal>;
  qualifyTemplate(input: { inspectionId: string; proposal: ConfigurationProposal; workingTemplatePath: string }, signal: AbortSignal): Promise<TemplateProfile>;
  inspectModelProfile(profile: ModelProfile, signal: AbortSignal): Promise<{ available: boolean; errors: DomainError[] }>;
  qualifyModelProfile(profile: ModelProfile, signal: AbortSignal): Promise<{ qualified: boolean; evidencePaths: string[]; errors: DomainError[] }>;
}

export interface JobService {
  validate(spec: JobSpec): Promise<{ valid: boolean; errors: DomainError[] }>;
  start(spec: JobSpec): Promise<{ jobId: string }>;
  pause(jobId: string): Promise<void>;
  resume(jobId: string): Promise<void>;
  cancel(jobId: string): Promise<void>;
  retryFailed(jobId: string): Promise<{ jobId: string }>;
  visualReview(jobId: string, assetId: string): Promise<VisualReviewRequest | null>;
  submitVisualAttestation(requestId: string, decision: 'approve' | 'reject', notes: string): Promise<void>;
  snapshot(jobId: string): Promise<JobSnapshot>;
  subscribe(jobId: string, listener: (event: JobEvent) => void): () => void;
}
