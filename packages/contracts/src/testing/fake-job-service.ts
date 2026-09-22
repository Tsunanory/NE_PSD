import {
  JobEventSchema,
  JobSpecSchema,
  JobSnapshotSchema,
  type DomainError,
  type JobEvent,
  type JobService,
  type JobSnapshot,
  type JobSpec,
  type VisualReviewRequest,
  VisualReviewRequestSchema,
} from '../index.js';
import { sha256Text } from '../canonicalize.js';
import {
  FakeFailureError,
  type FakeConfig,
  fixedClock,
  resolveFailureSchedule,
  testOnlyPath,
} from './fixture-loader.js';

export type FakeJobServiceOptions = FakeConfig & {
  readonly initialSnapshots?: Readonly<Record<string, JobSnapshot>>;
};

export class FakeJobService implements JobService {
  readonly testOnly = true as const;
  private readonly clock;
  private readonly schedule;
  private readonly snapshots = new Map<string, JobSnapshot>();
  private readonly specs = new Map<string, JobSpec>();
  private readonly eventsByJob = new Map<string, JobEvent[]>();
  private readonly listeners = new Map<string, Set<(event: JobEvent) => void>>();
  private nextSequence = 0;

  constructor(options: FakeJobServiceOptions = {}) {
    this.clock = options.clock ?? fixedClock();
    this.schedule = resolveFailureSchedule(options);
    for (const [jobId, snapshot] of Object.entries(options.initialSnapshots ?? {})) this.snapshots.set(jobId, JobSnapshotSchema.parse(snapshot));
  }

  async validate(spec: JobSpec): Promise<{ valid: boolean; errors: DomainError[] }> {
    const parsed = JobSpecSchema.safeParse(spec);
    return parsed.success ? { valid: true, errors: [] } : { valid: false, errors: [this.error('INVALID_JOB_SPEC', 'validation', parsed.error.message, false)] };
  }

  async start(spec: JobSpec): Promise<{ jobId: string }> {
    const validation = await this.validate(spec);
    if (!validation.valid) throw new FakeFailureError('invalidJobSpec', validation.errors[0]?.message ?? 'invalid job spec');
    this.failIfScheduled('caseCollision', 'sourceChanged', 'crashBeforePublish', 'storage:start');
    this.specs.set(spec.jobId, spec);
    const snapshot = this.snapshotFor(spec, 'running');
    this.snapshots.set(spec.jobId, snapshot);
    this.emit(spec.jobId, snapshot);
    return { jobId: spec.jobId };
  }

  async pause(jobId: string): Promise<void> {
    const current = this.requireSnapshot(jobId);
    this.update(jobId, { ...current, state: 'paused' });
  }

  async resume(jobId: string): Promise<void> {
    const current = this.requireSnapshot(jobId);
    this.update(jobId, { ...current, state: 'running' });
  }

  async cancel(jobId: string): Promise<void> {
    this.failIfScheduled('cancelDuringChildSave', 'storage:cancel');
    const current = this.requireSnapshot(jobId);
    this.update(jobId, { ...current, state: 'cancelled', assets: current.assets.map((asset) => asset.status === 'complete' ? asset : { ...asset, status: 'cancelled' }) });
  }

  async retryFailed(jobId: string): Promise<{ jobId: string }> {
    const current = this.requireSnapshot(jobId);
    const spec = this.specs.get(jobId);
    if (spec === undefined) throw new Error(`unknown fake job: ${jobId}`);
    this.update(jobId, {
      ...current,
      state: 'running',
      assets: current.assets.map((asset) => asset.status === 'failed' || asset.status === 'blocked' ? { ...asset, status: 'queued', attempt: asset.attempt + 1, error: null } : asset),
    });
    return { jobId: spec.jobId };
  }

  async visualReview(jobId: string, assetId: string): Promise<VisualReviewRequest | null> {
    this.failIfScheduled('reviewOffline', 'reviewDigestMismatch', 'storage:visualReview');
    const spec = this.specs.get(jobId);
    if (spec === undefined) return null;
    const asset = spec.assets.find((candidate) => candidate.assetId === assetId);
    if (asset === undefined) return null;
    const artifacts = spec.profile.variants.map((variant) => ({
      variantId: variant.id,
      path: testOnlyPath(`review/${jobId}/${assetId}/variant-${variant.id}.jpg`),
      sha256: sha256Text(`testOnly:${jobId}:${assetId}:${variant.id}`),
      bytes: 1,
      colorSpace: 'sRGB' as const,
      width: spec.profile.output.width,
      height: spec.profile.output.height,
      format: 'jpeg' as const,
    }));
    const request = VisualReviewRequestSchema.parse({
      requestId: testOnlyPath(`review/${jobId}/${assetId}/request`),
      jobId,
      assetId,
      attempt: 1,
      preAttestationContentSha256: sha256Text(`attestation:${jobId}:${assetId}`),
      profileSha256: spec.profile.profileSha256,
      sourceSha256: asset.source.sha256,
      toolSchemaSha256: spec.profile.toolSchemaSha256,
      reviewPolicySha256: spec.reviewPolicySha256,
      artifacts,
      contactSheet: { relativePath: testOnlyPath(`review/${jobId}/${assetId}/contact-sheet.jpg`), sha256: sha256Text(`contact:${jobId}:${assetId}`) },
    });
    return request;
  }

  async snapshot(jobId: string): Promise<JobSnapshot> {
    return this.requireSnapshot(jobId);
  }

  subscribe(jobId: string, listener: (event: JobEvent) => void): () => void {
    const listeners = this.listeners.get(jobId) ?? new Set<(event: JobEvent) => void>();
    listeners.add(listener);
    this.listeners.set(jobId, listeners);
    return () => listeners.delete(listener);
  }

  publish(jobId: string): void {
    this.failIfScheduled('crashBeforePublish');
    const snapshot = this.requireSnapshot(jobId);
    const complete = { ...snapshot, state: 'completed' as const, complete: snapshot.total, assets: snapshot.assets.map((asset) => ({ ...asset, status: 'complete' as const })) };
    this.snapshots.set(jobId, complete);
    if (this.schedule.consume('crashAfterPublishBeforeDb')) throw new FakeFailureError('crashAfterPublishBeforeDb');
    this.emit(jobId, complete);
  }

  events(jobId: string): readonly JobEvent[] {
    return (this.eventsByJob.get(jobId) ?? []).map((event) => ({ ...event }));
  }

  private snapshotFor(spec: JobSpec, state: JobSnapshot['state']): JobSnapshot {
    return JobSnapshotSchema.parse({
      jobId: spec.jobId,
      state,
      total: spec.assets.length,
      complete: 0,
      failed: 0,
      blocked: 0,
      assets: spec.assets.map((asset) => ({ assetId: asset.assetId, status: 'queued', attempt: 0, error: null })),
    });
  }

  private update(jobId: string, snapshot: JobSnapshot): void {
    this.failIfScheduled('storage:update');
    const parsed = JobSnapshotSchema.parse(snapshot);
    this.snapshots.set(jobId, parsed);
    this.emit(jobId, parsed);
  }

  private emit(jobId: string, snapshot: JobSnapshot): void {
    this.failIfScheduled('storage:event');
    const event = JobEventSchema.parse({ schemaVersion: 1, jobId, sequence: ++this.nextSequence, timestamp: this.clock.now().toISOString(), kind: 'snapshot', snapshot });
    const events = this.eventsByJob.get(jobId) ?? [];
    events.push(event);
    this.eventsByJob.set(jobId, events);
    for (const listener of this.listeners.get(jobId) ?? []) listener(event);
  }

  private requireSnapshot(jobId: string): JobSnapshot {
    const snapshot = this.snapshots.get(jobId);
    if (snapshot === undefined) throw new Error(`unknown fake job: ${jobId}`);
    return snapshot;
  }

  private failIfScheduled(...names: string[]): void {
    for (const name of names) if (this.schedule.consume(name)) throw new FakeFailureError(name);
  }

  private error(code: string, category: DomainError['category'], message: string, retryable: boolean): DomainError {
    return { code, category, message, retryable, evidencePaths: ['testOnly/job/errors.json'] };
  }
}

export function createFakeJobService(options: FakeJobServiceOptions = {}): FakeJobService {
  return new FakeJobService(options);
}
