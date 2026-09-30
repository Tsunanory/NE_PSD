import { z } from 'zod';
import {
  AssetSchema, ConfigurationProposalSchema, DomainErrorSchema, InspectionReportSchema,
  JobEventSchema, JobSnapshotSchema, JobSpecSchema, ModelProfileSchema, TemplateProfileSchema,
  VisualReviewRequestSchema,
  type ConfigurationProposal, type DomainError, type InspectionReport, type JobEvent,
  type JobSnapshot, type JobSpec, type ModelProfile, type TemplateProfile, type VisualReviewRequest,
} from '@ne-psd/contracts';
import type { ModelEvidence } from '../renderer/setup/model-state.js';
import type { AssetSelection, ModelOption, OutputSelection, Preview, TemplateSelection } from './setup-controller.js';

const id = z.string().min(1);
const handle = z.string().uuid();
const job = z.object({ jobId: id }).strict();
const profile = z.object({ profile: ModelProfileSchema }).strict();
const errors = z.array(DomainErrorSchema);
const empty = z.object({}).strict();
const previewSchema = z.object({ variantId: z.enum(['1', '2', '3']), profileSha256: z.string().regex(/^[0-9a-f]{64}$/), sha256: z.string().regex(/^[0-9a-f]{64}$/), dataUrl: z.string().regex(/^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/).max(10_000_000), synthetic: z.boolean() }).strict();
const modelEvidenceSchema = z.object({
  label: id, modelId: id, artifactSha256: z.string(), runtimeVersion: z.string(), chatTemplateSha256: z.string(),
  quantization: z.enum(['Q4', 'Q5', 'Q6', 'Q8']), contextTokens: z.number().int().nonnegative(), maxOutputTokens: z.number().int().nonnegative(),
  capabilities: z.object({ jsonSchema: z.boolean(), tools: z.boolean(), vision: z.boolean() }).strict(),
  benchmark: z.object({ passed: z.boolean(), latencyMs: z.number().finite().nonnegative() }).strict(),
  resources: z.object({ peakRamGb: z.number().finite().nonnegative(), peakVramGb: z.number().finite().nonnegative(), requiredHeadroomGb: z.number().finite().nonnegative() }).strict(),
  artifactVerified: z.boolean(), endpointReachable: z.boolean(), reviewGateAvailable: z.boolean(), synthetic: z.boolean(),
  selectedProfile: ModelProfileSchema.optional(),
  qualification: z.object({ qualified: z.boolean(), evidencePaths: z.array(id), errors }).strict().optional(),
}).strict();
const templateSelectionSchema = z.object({ handle, label: id, relativePath: id, sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const assetSelectionSchema = z.object({ rootHandle: handle, label: id, assets: z.array(AssetSchema), rejected: z.array(z.object({ name: id, reason: id }).strict()) }).strict();
const outputSelectionSchema = z.object({ rootHandle: handle, label: id, freeBytes: z.number().finite().nonnegative() }).strict();
const reviewImageSchema = z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), dataUrl: z.string().regex(/^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/).max(70_000_000) }).strict();
const verifiedReviewImagesSchema = z.object({ requestId: id, jobId: id, assetId: id, attempt: z.union([z.literal(1), z.literal(2)]), variants: z.array(reviewImageSchema.extend({ variantId: z.enum(['1', '2', '3']) })).length(3), contactSheet: reviewImageSchema, synthetic: z.boolean() }).strict();
const assetDetailSchema = z.object({
  available: z.boolean(), synthetic: z.boolean(), attempts: z.array(z.object({
    attempt: z.union([z.literal(1), z.literal(2)]), reviewId: id, verdict: z.enum(['pass', 'revise', 'blocked']),
    variants: z.array(z.object({ variantId: z.enum(['1', '2', '3']), verdict: z.enum(['pass', 'fail', 'unknown']), evidenceIds: z.array(z.string().regex(/^[0-9a-f]{64}$/)) }).strict()).length(3),
    checks: z.array(z.object({ requirementId: z.string().regex(/^[A-Z][A-Z0-9_.]{0,99}$/), result: z.enum(['pass', 'fail', 'unknown']), evidenceIds: z.array(z.string().regex(/^[0-9a-f]{64}$/)), reason: z.string().max(1024) }).strict()).max(100),
    evidenceIds: z.array(z.string().regex(/^[0-9a-f]{64}$/)),
    diagnostics: z.array(z.object({ evidenceId: z.string().regex(/^[0-9a-f]{64}$/), code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), summary: z.string().max(1024) }).strict()).max(20),
  }).strict()).max(2),
}).strict();

export const ipcRequests = {
  'job.validate': z.object({ spec: JobSpecSchema }).strict(),
  'job.start': z.object({ spec: JobSpecSchema }).strict(),
  'job.pause': job, 'job.resume': job, 'job.cancel': job, 'job.snapshot': job, 'job.retryFailed': job,
  'job.visualReview': z.object({ jobId: id, assetId: id }).strict(),
  'job.reviewImages': z.object({ jobId: id, assetId: id }).strict(),
  'job.assetDetail': z.object({ jobId: id, assetId: id }).strict(),
  'job.openCommittedOutput': z.object({ jobId: id, assetId: id }).strict(),
  'job.recent': empty,
  'job.submitVisualAttestation': z.object({ requestId: id, decision: z.enum(['approve', 'reject']), notes: z.string() }).strict(),
  'job.subscribe': job, 'job.unsubscribe': z.object({ subscriptionId: handle }).strict(),
  'setup.chooseTemplate': empty, 'setup.chooseAssets': empty, 'setup.chooseOutput': empty,
  'setup.catalog': empty,
  'setup.inspect': z.object({ templateHandle: handle, relativePath: id }).strict(),
  'setup.propose': z.object({ instruction: id, inspectionId: id, modelProfileId: id }).strict(),
  'setup.qualify': z.object({ proposal: ConfigurationProposalSchema }).strict(),
  'setup.confirmPreviews': z.object({ profileSha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
  'setup.saveCandidate': z.object({ proposal: ConfigurationProposalSchema }).strict(),
  'setup.loadCandidate': empty, 'setup.saveProfile': empty, 'setup.loadProfile': empty,
  'setup.selectModels': z.object({ plannerProfileId: id, reviewerProfileId: id }).strict(),
  'setup.inspectModel': profile, 'setup.qualifyModel': profile,
  'setup.start': empty,
  'dev.startFakeCorpus': z.object({ count: z.number().int().min(1).max(10_000) }).strict(),
  'dev.completeFakeJob': job,
  'dev.failFakeJob': job,
  'dev.fakeJobMetrics': job,
  'app.diagnostic': empty,
  'app.safeClose': empty,
} as const;
export type IpcChannel = keyof typeof ipcRequests;
export const IPC_CHANNELS = Object.keys(ipcRequests) as IpcChannel[];

export const ipcResponses = {
  'job.validate': z.object({ valid: z.boolean(), errors }).strict(),
  'job.start': job,
  'job.pause': z.null(), 'job.resume': z.null(), 'job.cancel': z.null(),
  'job.snapshot': JobSnapshotSchema, 'job.retryFailed': job,
  'job.visualReview': VisualReviewRequestSchema.nullable(), 'job.submitVisualAttestation': z.null(),
  'job.reviewImages': verifiedReviewImagesSchema, 'job.openCommittedOutput': z.null(),
  'job.assetDetail': assetDetailSchema,
  'job.recent': z.array(z.object({ jobId: id, snapshot: JobSnapshotSchema }).strict()).max(20),
  'job.subscribe': z.object({ subscriptionId: handle }).strict(), 'job.unsubscribe': z.null(),
  'setup.chooseTemplate': templateSelectionSchema.nullable(),
  'setup.chooseAssets': assetSelectionSchema.nullable(),
  'setup.chooseOutput': outputSelectionSchema.nullable(),
  'setup.catalog': z.object({ models: z.array(z.object({ profile: ModelProfileSchema, evidence: modelEvidenceSchema }).strict()), reviewPolicySha256: z.string().regex(/^[0-9a-f]{64}$/), developmentFake: z.boolean() }).strict(),
  'setup.inspect': InspectionReportSchema, 'setup.propose': ConfigurationProposalSchema,
  'setup.qualify': z.object({ profile: TemplateProfileSchema, previews: z.tuple([previewSchema, previewSchema, previewSchema]) }).strict(),
  'setup.confirmPreviews': TemplateProfileSchema,
  'setup.saveCandidate': z.null(), 'setup.loadCandidate': ConfigurationProposalSchema,
  'setup.saveProfile': z.null(), 'setup.loadProfile': TemplateProfileSchema,
  'setup.selectModels': z.null(),
  'setup.inspectModel': z.object({ available: z.boolean(), errors }).strict(),
  'setup.qualifyModel': z.object({ qualified: z.boolean(), evidencePaths: z.array(id), errors }).strict(),
  'setup.start': job,
  'dev.startFakeCorpus': job, 'dev.completeFakeJob': z.null(), 'dev.failFakeJob': z.null(),
  'dev.fakeJobMetrics': z.object({ activeSubscriptions: z.number().int().nonnegative(), lastSequence: z.number().int().nonnegative(), eventCount: z.number().int().nonnegative(), state: id, complete: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).strict(),
  'app.diagnostic': z.object({ available: z.boolean() }).strict(),
  'app.safeClose': z.null(),
} as const;

type Requests = {
  'job.validate': { spec: JobSpec }; 'job.start': { spec: JobSpec };
  'job.pause': { jobId: string }; 'job.resume': { jobId: string }; 'job.cancel': { jobId: string };
  'job.snapshot': { jobId: string }; 'job.retryFailed': { jobId: string };
  'job.visualReview': { jobId: string; assetId: string };
  'job.reviewImages': { jobId: string; assetId: string };
  'job.assetDetail': { jobId: string; assetId: string };
  'job.openCommittedOutput': { jobId: string; assetId: string };
  'job.recent': Record<string, never>;
  'job.submitVisualAttestation': { requestId: string; decision: 'approve' | 'reject'; notes: string };
  'job.subscribe': { jobId: string }; 'job.unsubscribe': { subscriptionId: string };
  'setup.chooseTemplate': Record<string, never>; 'setup.chooseAssets': Record<string, never>; 'setup.chooseOutput': Record<string, never>;
  'setup.catalog': Record<string, never>;
  'setup.inspect': { templateHandle: string; relativePath: string };
  'setup.propose': { instruction: string; inspectionId: string; modelProfileId: string };
  'setup.qualify': { proposal: ConfigurationProposal };
  'setup.confirmPreviews': { profileSha256: string };
  'setup.saveCandidate': { proposal: ConfigurationProposal }; 'setup.loadCandidate': Record<string, never>;
  'setup.saveProfile': Record<string, never>; 'setup.loadProfile': Record<string, never>;
  'setup.selectModels': { plannerProfileId: string; reviewerProfileId: string };
  'setup.inspectModel': { profile: ModelProfile }; 'setup.qualifyModel': { profile: ModelProfile };
  'setup.start': Record<string, never>;
  'dev.startFakeCorpus': { count: number }; 'dev.completeFakeJob': { jobId: string }; 'dev.failFakeJob': { jobId: string }; 'dev.fakeJobMetrics': { jobId: string };
  'app.diagnostic': Record<string, never>;
  'app.safeClose': Record<string, never>;
};
type Responses = {
  'job.validate': { valid: boolean; errors: DomainError[] }; 'job.start': { jobId: string };
  'job.pause': void; 'job.resume': void; 'job.cancel': void;
  'job.snapshot': JobSnapshot; 'job.retryFailed': { jobId: string };
  'job.visualReview': VisualReviewRequest | null; 'job.submitVisualAttestation': void;
  'job.reviewImages': z.infer<typeof verifiedReviewImagesSchema>; 'job.openCommittedOutput': void;
  'job.assetDetail': z.infer<typeof assetDetailSchema>;
  'job.recent': Array<{ jobId: string; snapshot: JobSnapshot }>;
  'job.subscribe': { subscriptionId: string }; 'job.unsubscribe': void;
  'setup.chooseTemplate': TemplateSelection | null; 'setup.chooseAssets': AssetSelection | null; 'setup.chooseOutput': OutputSelection | null;
  'setup.catalog': { models: ModelOption[]; reviewPolicySha256: string; developmentFake: boolean };
  'setup.inspect': InspectionReport; 'setup.propose': ConfigurationProposal;
  'setup.qualify': { profile: TemplateProfile; previews: [Preview, Preview, Preview] };
  'setup.confirmPreviews': TemplateProfile;
  'setup.saveCandidate': void; 'setup.loadCandidate': ConfigurationProposal;
  'setup.saveProfile': void; 'setup.loadProfile': TemplateProfile;
  'setup.selectModels': void;
  'setup.inspectModel': { available: boolean; errors: DomainError[] };
  'setup.qualifyModel': { qualified: boolean; evidencePaths: string[]; errors: DomainError[] };
  'setup.start': { jobId: string };
  'dev.startFakeCorpus': { jobId: string }; 'dev.completeFakeJob': void; 'dev.failFakeJob': void;
  'dev.fakeJobMetrics': { activeSubscriptions: number; lastSequence: number; eventCount: number; state: string; complete: number; total: number };
  'app.diagnostic': { available: boolean };
  'app.safeClose': void;
};

function schemaFor<C extends IpcChannel>(schemas: Record<IpcChannel, z.ZodTypeAny>, channel: C): z.ZodTypeAny {
  if (!(channel in schemas)) throw new Error('unknown IPC channel');
  return schemas[channel];
}
export function validateRequest<C extends IpcChannel>(channel: C, payload: unknown): Requests[C] {
  return schemaFor(ipcRequests, channel).parse(payload) as Requests[C];
}
export function validateResponse<C extends IpcChannel>(channel: C, value: unknown): unknown {
  return schemaFor(ipcResponses, channel).parse(value === undefined && ipcResponses[channel] instanceof z.ZodNull ? null : value);
}
export function parseResponse<C extends IpcChannel>(channel: C, value: unknown): Responses[C] {
  const parsed = validateResponse(channel, value);
  return (ipcResponses[channel] instanceof z.ZodNull ? undefined : parsed) as Responses[C];
}
export function validateEvent(value: unknown): JobEvent { return JobEventSchema.parse(value); }

export type BridgeTransport = {
  invoke<C extends IpcChannel>(channel: C, payload: Requests[C]): Promise<unknown>;
  subscribe(listener: (value: unknown) => void): () => void;
};
export type BridgeApi = {
  validateJob(request: Requests['job.validate']): Promise<Responses['job.validate']>;
  startJob(request: Requests['job.start']): Promise<Responses['job.start']>;
  pauseJob(request: Requests['job.pause']): Promise<void>;
  resumeJob(request: Requests['job.resume']): Promise<void>;
  cancelJob(request: Requests['job.cancel']): Promise<void>;
  snapshotJob(request: Requests['job.snapshot']): Promise<JobSnapshot>;
  retryFailed(request: Requests['job.retryFailed']): Promise<Responses['job.retryFailed']>;
  visualReview(request: Requests['job.visualReview']): Promise<VisualReviewRequest | null>;
  reviewImages(request: Requests['job.reviewImages']): Promise<Responses['job.reviewImages']>;
  assetDetail(request: Requests['job.assetDetail']): Promise<Responses['job.assetDetail']>;
  openCommittedOutput(request: Requests['job.openCommittedOutput']): Promise<void>;
  recentJobs(): Promise<Responses['job.recent']>;
  submitVisualAttestation(request: Requests['job.submitVisualAttestation']): Promise<void>;
  chooseTemplate(): Promise<TemplateSelection | null>;
  chooseAssets(): Promise<AssetSelection | null>;
  chooseOutput(): Promise<OutputSelection | null>;
  setupCatalog(): Promise<Responses['setup.catalog']>;
  inspectSetup(request: Requests['setup.inspect']): Promise<InspectionReport>;
  proposeSetup(request: Requests['setup.propose']): Promise<ConfigurationProposal>;
  qualifySetup(request: Requests['setup.qualify']): Promise<Responses['setup.qualify']>;
  confirmPreviews(request: Requests['setup.confirmPreviews']): Promise<TemplateProfile>;
  saveCandidate(request: Requests['setup.saveCandidate']): Promise<void>;
  loadCandidate(): Promise<ConfigurationProposal>;
  saveProfile(): Promise<void>;
  loadProfile(): Promise<TemplateProfile>;
  selectModels(request: Requests['setup.selectModels']): Promise<void>;
  inspectModel(request: Requests['setup.inspectModel']): Promise<Responses['setup.inspectModel']>;
  qualifyModel(request: Requests['setup.qualifyModel']): Promise<Responses['setup.qualifyModel']>;
  startSetupJob(): Promise<{ jobId: string }>;
  startFakeCorpus?: (request: Requests['dev.startFakeCorpus']) => Promise<{ jobId: string }>;
  completeFakeJob?: (request: Requests['dev.completeFakeJob']) => Promise<void>;
  failFakeJob?: (request: Requests['dev.failFakeJob']) => Promise<void>;
  fakeJobMetrics?: (request: Requests['dev.fakeJobMetrics']) => Promise<Responses['dev.fakeJobMetrics']>;
  diagnostic(request: Requests['app.diagnostic']): Promise<Responses['app.diagnostic']>;
  safeClose(): Promise<void>;
  subscribeJob(jobId: string, listener: (event: JobEvent) => void): Promise<() => void>;
};
export function createBridgeApi(transport: BridgeTransport, includeDev = false): BridgeApi {
  const call = <C extends IpcChannel>(channel: C, request: Requests[C]): Promise<Responses[C]> => {
    const validated = validateRequest(channel, request);
    return transport.invoke(channel, validated).then((value) => parseResponse(channel, value));
  };
  return {
    validateJob: (request) => call('job.validate', request), startJob: (request) => call('job.start', request),
    pauseJob: (request) => call('job.pause', request), resumeJob: (request) => call('job.resume', request),
    cancelJob: (request) => call('job.cancel', request), snapshotJob: (request) => call('job.snapshot', request),
  retryFailed: (request) => call('job.retryFailed', request), visualReview: (request) => call('job.visualReview', request),
  reviewImages: (request) => call('job.reviewImages', request),
  assetDetail: (request) => call('job.assetDetail', request),
  openCommittedOutput: (request) => call('job.openCommittedOutput', request), recentJobs: () => call('job.recent', {}),
    submitVisualAttestation: (request) => call('job.submitVisualAttestation', request),
    chooseTemplate: () => call('setup.chooseTemplate', {}), chooseAssets: () => call('setup.chooseAssets', {}),
    chooseOutput: () => call('setup.chooseOutput', {}), setupCatalog: () => call('setup.catalog', {}),
    inspectSetup: (request) => call('setup.inspect', request), proposeSetup: (request) => call('setup.propose', request),
    qualifySetup: (request) => call('setup.qualify', request), confirmPreviews: (request) => call('setup.confirmPreviews', request),
    saveCandidate: (request) => call('setup.saveCandidate', request), loadCandidate: () => call('setup.loadCandidate', {}),
    saveProfile: () => call('setup.saveProfile', {}), loadProfile: () => call('setup.loadProfile', {}),
    selectModels: (request) => call('setup.selectModels', request),
    inspectModel: (request) => call('setup.inspectModel', request), qualifyModel: (request) => call('setup.qualifyModel', request),
    startSetupJob: () => call('setup.start', {}),
    ...(includeDev ? {
      startFakeCorpus: (request: Requests['dev.startFakeCorpus']) => call('dev.startFakeCorpus', request),
      completeFakeJob: (request: Requests['dev.completeFakeJob']) => call('dev.completeFakeJob', request),
      failFakeJob: (request: Requests['dev.failFakeJob']) => call('dev.failFakeJob', request),
      fakeJobMetrics: (request: Requests['dev.fakeJobMetrics']) => call('dev.fakeJobMetrics', request),
    } : {}),
  diagnostic: (request) => call('app.diagnostic', request),
  safeClose: () => call('app.safeClose', {}),
    subscribeJob: async (jobId, listener) => {
      const { subscriptionId } = await call('job.subscribe', { jobId });
      const unsubscribe = transport.subscribe((value) => {
        const envelope = z.object({ subscriptionId: handle, event: JobEventSchema }).strict().safeParse(value);
        if (envelope.success && envelope.data.subscriptionId === subscriptionId) listener(envelope.data.event);
      });
      return () => { unsubscribe(); void call('job.unsubscribe', { subscriptionId }).catch(() => undefined); };
    },
  };
}
