import { z } from 'zod';
import {
  ConfigurationProposalSchema, DomainErrorSchema, InspectionReportSchema, JobEventSchema,
  JobSnapshotSchema, JobSpecSchema, ModelProfileSchema, TemplateProfileSchema,
  VisualReviewRequestSchema,
  type ConfigurationProposal, type DomainError, type InspectionReport, type JobEvent,
  type JobSnapshot, type JobSpec, type ModelProfile, type TemplateProfile, type VisualReviewRequest,
} from '@ne-psd/contracts';

const id = z.string().min(1);
const handle = z.string().uuid();
const job = z.object({ jobId: id }).strict();
const profile = z.object({ profile: ModelProfileSchema }).strict();
const errors = z.array(DomainErrorSchema);

export const ipcRequests = {
  'job.validate': z.object({ spec: JobSpecSchema }).strict(),
  'job.start': z.object({ spec: JobSpecSchema }).strict(),
  'job.pause': job,
  'job.resume': job,
  'job.cancel': job,
  'job.snapshot': job,
  'job.retryFailed': job,
  'job.visualReview': z.object({ jobId: id, assetId: id }).strict(),
  'job.submitVisualAttestation': z.object({ requestId: id, decision: z.enum(['approve', 'reject']), notes: z.string() }).strict(),
  'job.subscribe': job,
  'job.unsubscribe': z.object({ subscriptionId: handle }).strict(),
  'setup.inspect': z.object({ templateHandle: handle, relativePath: z.string().min(1) }).strict(),
  'setup.propose': z.object({ instruction: id, inspectionId: id, modelProfileId: id }).strict(),
  'setup.qualify': z.object({ inspectionId: id, proposal: ConfigurationProposalSchema, workingTemplateHandle: handle, relativePath: z.string().min(1) }).strict(),
  'setup.inspectModel': profile,
  'setup.qualifyModel': profile,
  'app.diagnostic': z.object({}).strict(),
} as const;
export type IpcChannel = keyof typeof ipcRequests;
export const IPC_CHANNELS = Object.keys(ipcRequests) as IpcChannel[];

export const ipcResponses = {
  'job.validate': z.object({ valid: z.boolean(), errors }).strict(),
  'job.start': job,
  'job.pause': z.null(),
  'job.resume': z.null(),
  'job.cancel': z.null(),
  'job.snapshot': JobSnapshotSchema,
  'job.retryFailed': job,
  'job.visualReview': VisualReviewRequestSchema.nullable(),
  'job.submitVisualAttestation': z.null(),
  'job.subscribe': z.object({ subscriptionId: handle }).strict(),
  'job.unsubscribe': z.null(),
  'setup.inspect': InspectionReportSchema,
  'setup.propose': ConfigurationProposalSchema,
  'setup.qualify': TemplateProfileSchema,
  'setup.inspectModel': z.object({ available: z.boolean(), errors }).strict(),
  'setup.qualifyModel': z.object({ qualified: z.boolean(), evidencePaths: z.array(id), errors }).strict(),
  'app.diagnostic': z.object({ available: z.boolean() }).strict(),
} as const;

type Requests = {
  'job.validate': { spec: JobSpec }; 'job.start': { spec: JobSpec };
  'job.pause': { jobId: string }; 'job.resume': { jobId: string }; 'job.cancel': { jobId: string };
  'job.snapshot': { jobId: string }; 'job.retryFailed': { jobId: string };
  'job.visualReview': { jobId: string; assetId: string };
  'job.submitVisualAttestation': { requestId: string; decision: 'approve' | 'reject'; notes: string };
  'job.subscribe': { jobId: string }; 'job.unsubscribe': { subscriptionId: string };
  'setup.inspect': { templateHandle: string; relativePath: string };
  'setup.propose': { instruction: string; inspectionId: string; modelProfileId: string };
  'setup.qualify': { inspectionId: string; proposal: ConfigurationProposal; workingTemplateHandle: string; relativePath: string };
  'setup.inspectModel': { profile: ModelProfile }; 'setup.qualifyModel': { profile: ModelProfile };
  'app.diagnostic': Record<string, never>;
};

type Responses = {
  'job.validate': { valid: boolean; errors: DomainError[] }; 'job.start': { jobId: string };
  'job.pause': void; 'job.resume': void; 'job.cancel': void;
  'job.snapshot': JobSnapshot; 'job.retryFailed': { jobId: string };
  'job.visualReview': VisualReviewRequest | null; 'job.submitVisualAttestation': void;
  'job.subscribe': { subscriptionId: string }; 'job.unsubscribe': void;
  'setup.inspect': InspectionReport; 'setup.propose': ConfigurationProposal; 'setup.qualify': TemplateProfile;
  'setup.inspectModel': { available: boolean; errors: DomainError[] };
  'setup.qualifyModel': { qualified: boolean; evidencePaths: string[]; errors: DomainError[] };
  'app.diagnostic': { available: boolean };
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
  submitVisualAttestation(request: Requests['job.submitVisualAttestation']): Promise<void>;
  inspectSetup(request: Requests['setup.inspect']): Promise<InspectionReport>;
  proposeSetup(request: Requests['setup.propose']): Promise<ConfigurationProposal>;
  qualifySetup(request: Requests['setup.qualify']): Promise<TemplateProfile>;
  inspectModel(request: Requests['setup.inspectModel']): Promise<Responses['setup.inspectModel']>;
  qualifyModel(request: Requests['setup.qualifyModel']): Promise<Responses['setup.qualifyModel']>;
  diagnostic(request: Requests['app.diagnostic']): Promise<Responses['app.diagnostic']>;
  subscribeJob(jobId: string, listener: (event: JobEvent) => void): Promise<() => void>;
};
export function createBridgeApi(transport: BridgeTransport): BridgeApi {
  const call = <C extends IpcChannel>(channel: C, request: Requests[C]): Promise<Responses[C]> => {
    const validated = validateRequest(channel, request);
    return transport.invoke(channel, validated).then((value) => parseResponse(channel, value));
  };
  return {
    validateJob: (request) => call('job.validate', request), startJob: (request) => call('job.start', request),
    pauseJob: (request) => call('job.pause', request), resumeJob: (request) => call('job.resume', request),
    cancelJob: (request) => call('job.cancel', request), snapshotJob: (request) => call('job.snapshot', request),
    retryFailed: (request) => call('job.retryFailed', request), visualReview: (request) => call('job.visualReview', request),
    submitVisualAttestation: (request) => call('job.submitVisualAttestation', request),
    inspectSetup: (request) => call('setup.inspect', request), proposeSetup: (request) => call('setup.propose', request),
    qualifySetup: (request) => call('setup.qualify', request), inspectModel: (request) => call('setup.inspectModel', request),
    qualifyModel: (request) => call('setup.qualifyModel', request), diagnostic: (request) => call('app.diagnostic', request),
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
