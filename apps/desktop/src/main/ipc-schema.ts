import { z } from 'zod';
import { ConfigurationProposalSchema, JobSpecSchema } from '@ne-psd/contracts';
export const IPC_CHANNELS = ['job.validate','job.start','job.pause','job.resume','job.cancel','job.snapshot','job.retryFailed','job.visualReview','job.submitVisualAttestation','setup.inspect','setup.propose','setup.qualify','app.diagnostic'] as const;
export type IpcChannel = typeof IPC_CHANNELS[number];
const ids = z.object({ jobId: z.string().min(1) }).strict();
const requests: Record<IpcChannel, z.ZodTypeAny> = {
  'job.validate': z.object({ spec: JobSpecSchema }).strict(),
  'job.start': z.object({ spec: JobSpecSchema }).strict(),
  'job.pause': ids, 'job.resume': ids, 'job.cancel': ids, 'job.snapshot': ids, 'job.retryFailed': ids,
  'job.visualReview': z.object({ jobId: z.string().min(1), assetId: z.string().min(1) }).strict(),
  'job.submitVisualAttestation': z.object({ requestId: z.string().min(1), decision: z.enum(['approve', 'reject']), notes: z.string() }).strict(),
  'setup.inspect': z.object({ templatePath: z.string().min(1) }).strict(),
  'setup.propose': z.object({ instruction: z.string().min(1), inspectionId: z.string().min(1), modelProfileId: z.string().min(1) }).strict(),
  'setup.qualify': z.object({ inspectionId: z.string().min(1), proposal: ConfigurationProposalSchema, workingTemplatePath: z.string().min(1) }).strict(),
  'app.diagnostic': z.object({}).strict(),
};
export function validateRequest(channel: string, payload: unknown): unknown { if (!(IPC_CHANNELS as readonly string[]).includes(channel)) throw new Error(`unknown IPC channel: ${channel}`); const parsed = requests[channel as IpcChannel]!.safeParse(payload); if (!parsed.success) throw new Error(`invalid request for ${channel}`); return parsed.data; }
export function validateResponse<T>(value: T): T { const encoded = JSON.stringify(value); if (encoded === undefined) throw new Error('non-serializable response'); return JSON.parse(encoded) as T; }
export type BridgeTransport = { invoke(channel: IpcChannel, payload?: unknown): Promise<unknown>; subscribe(listener: (event: unknown) => void): () => void };
export type BridgeApi = { validateJob(p: {spec: unknown}): Promise<unknown>; startJob(p: {spec: unknown}): Promise<unknown>; pauseJob(p: {jobId:string}): Promise<unknown>; resumeJob(p: {jobId:string}): Promise<unknown>; cancelJob(p: {jobId:string}): Promise<unknown>; snapshotJob(p: {jobId:string}): Promise<unknown>; retryFailed(p: {jobId:string}): Promise<unknown>; visualReview(p: {jobId:string; assetId:string}): Promise<unknown>; submitVisualAttestation(p: {requestId:string; decision:'approve'|'reject'; notes:string}): Promise<unknown>; inspectSetup(p: Record<string,unknown>): Promise<unknown>; proposeSetup(p: Record<string,unknown>): Promise<unknown>; qualifySetup(p: Record<string,unknown>): Promise<unknown>; diagnostic(p: Record<string,unknown>): Promise<unknown>; subscribe(listener:(event:unknown)=>void):()=>void };
export function createBridgeApi(t: BridgeTransport): BridgeApi { const call = (c: IpcChannel, p: unknown) => t.invoke(c,p).then(validateResponse); return { validateJob:p=>call('job.validate',p), startJob:p=>call('job.start',p), pauseJob:p=>call('job.pause',p), resumeJob:p=>call('job.resume',p), cancelJob:p=>call('job.cancel',p), snapshotJob:p=>call('job.snapshot',p), retryFailed:p=>call('job.retryFailed',p), visualReview:p=>call('job.visualReview',p), submitVisualAttestation:p=>call('job.submitVisualAttestation',p), inspectSetup:p=>call('setup.inspect',p), proposeSetup:p=>call('setup.propose',p), qualifySetup:p=>call('setup.qualify',p), diagnostic:p=>call('app.diagnostic',p), subscribe:t.subscribe }; }
