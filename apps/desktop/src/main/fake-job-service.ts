import { FakeJobService as ContractFakeJobService, fixtureRoot, loadFixture } from '@ne-psd/contracts/testing';
import { JobEventSchema, JobSnapshotSchema, JobSpecSchema, VisualReviewRequestSchema, type JobEvent, type JobSnapshot, type JobSpec, type VisualReviewRequest } from '@ne-psd/contracts';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JobEvidenceAdapter } from './job-session-controller.js';

const fakeImage = async (name: string) => {
  const bytes = await readFile(join(fixtureRoot(), 'assets', name));
  return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
};

/** Only the explicit development fake binds review requests to synthetic fixture bytes. */
export function createFakeJobEvidenceAdapter(): JobEvidenceAdapter {
  return {
    async reviewImages(request) {
      const expected = ['1', '2', '3'].map((id) => `assets/variant-${id}.jpg`);
      if (request.artifacts.some((item, index) => item.path !== expected[index]) || request.contactSheet.relativePath !== 'assets/source.png') throw new Error('synthetic review request path mismatch');
      const files = [
        { relativePath: 'assets/source.png', sha256: request.contactSheet.sha256, bytes: (await fakeImage('source.png')).bytes, role: 'imageInput' as const },
        ...request.artifacts.map((item) => ({ relativePath: item.path, sha256: item.sha256, bytes: item.bytes, role: 'artifact' as const })),
      ];
      return { root: fixtureRoot(), manifest: {
        schemaVersion: 1 as const, jobId: request.jobId, assetId: request.assetId, attempt: request.attempt,
        files,
        visionInputs: request.artifacts.map((item) => ({ id: item.variantId, role: 'output' as const, relativePath: item.path, sha256: item.sha256, width: item.width, height: item.height, variantId: item.variantId, derivedFromSha256: item.sha256, crop: null })),
      } };
    },
    async committedOutput() { throw new Error('synthetic fixtures are not committed outputs'); },
  };
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

export function createFakeCorpusSpec(count: number, jobId = `fake-corpus-${count}`): JobSpec {
  if (!Number.isSafeInteger(count) || count < 1 || count > 10_000) throw new Error('fake corpus count must be 1..10000');
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(jobId)) throw new Error('invalid fake job ID');
  const base = loadFixture<JobSpec>('job.interactive.json');
  const source = base.assets[0];
  if (!source) throw new Error('fake asset fixture missing');
  const assets = Array.from({ length: count }, (_, index) => ({
    ...source,
    assetId: `asset-${index + 1}`,
    source: { ...source.source, relativePath: `assets/fake-${index + 1}.png` },
  }));
  return freezeDeep(JobSpecSchema.parse({ ...base, jobId, assets, trigger: 'interactive' }));
}

export class FakeJobService extends ContractFakeJobService {
  private readonly activeSubscriptions = new Map<string, number>();
  private readonly fixtureSnapshots = new Map<string, JobSnapshot>();
  private readonly fixtureEvents = new Map<string, JobEvent[]>();
  private readonly fixtureListeners = new Map<string, Set<(event: JobEvent) => void>>();

  private publishFixture(jobId: string, value: JobSnapshot): void {
    const snapshot = freezeDeep(JobSnapshotSchema.parse(value));
    const sequence = (this.events(jobId).at(-1)?.sequence ?? 0) + 1;
    const event = freezeDeep(JobEventSchema.parse({ schemaVersion: 1, jobId, sequence,
      timestamp: '2026-09-30T00:00:00.000Z', kind: 'snapshot', snapshot }));
    this.fixtureSnapshots.set(jobId, snapshot);
    this.fixtureEvents.set(jobId, [...this.fixtureEvents.get(jobId) ?? [], event]);
    for (const listener of this.fixtureListeners.get(jobId) ?? []) listener(event);
  }

  /** Explicit development-only failure driver; never exposed by the production IPC. */
  async failFakeJob(jobId: string): Promise<void> {
    const current = await this.snapshot(jobId);
    if (current.state !== 'running' || !current.assets[0]) throw new Error('fake job must be running');
    const failedAsset = current.assets[0];
    this.publishFixture(jobId, { ...current, state: 'failed', failed: current.failed + 1,
      assets: current.assets.map((asset, index) => index === 0 ? { ...failedAsset, status: 'failed',
        error: { code: 'FAKE_TRANSIENT', category: 'transient', message: 'synthetic transient failure', retryable: true,
          evidencePaths: ['testOnly/jobs/transient.json'] } } : asset) });
  }

  override async retryFailed(jobId: string): Promise<{ jobId: string }> {
    const failed = this.fixtureSnapshots.get(jobId);
    if (!failed || failed.state !== 'failed') throw new Error('fake job has no retryable failure');
    if (failed.assets.some((asset) => asset.status === 'failed' && asset.attempt >= 2)) throw new Error('fake attempt limit reached');
    const successor = await super.retryFailed(jobId);
    this.publishFixture(successor.jobId, { ...failed, jobId: successor.jobId, state: 'running', failed: 0,
      assets: failed.assets.map((asset) => asset.status === 'failed'
        ? { ...asset, status: 'queued', attempt: (asset.attempt + 1) as 1 | 2, error: null } : asset) });
    return successor;
  }

  override subscribe(jobId: string, listener: (event: JobEvent) => void): () => void {
    const unsubscribe = super.subscribe(jobId, listener);
    const fixtureListeners = this.fixtureListeners.get(jobId) ?? new Set<(event: JobEvent) => void>();
    fixtureListeners.add(listener);
    this.fixtureListeners.set(jobId, fixtureListeners);
    this.activeSubscriptions.set(jobId, (this.activeSubscriptions.get(jobId) ?? 0) + 1);
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      fixtureListeners.delete(listener);
      this.activeSubscriptions.set(jobId, (this.activeSubscriptions.get(jobId) ?? 1) - 1);
    };
  }

  override async snapshot(jobId: string): Promise<Readonly<JobSnapshot>> {
    return this.fixtureSnapshots.get(jobId) ?? freezeDeep(await super.snapshot(jobId));
  }

  override events(jobId: string): readonly JobEvent[] {
    return [...super.events(jobId), ...this.fixtureEvents.get(jobId) ?? []];
  }

  override async visualReview(jobId: string, assetId: string): Promise<VisualReviewRequest | null> {
    const original = await super.visualReview(jobId, assetId);
    if (!original) return null;
    const artifacts = await Promise.all(original.artifacts.map(async (item) => ({
      ...item, path: `assets/variant-${item.variantId}.jpg`, ...await fakeImage(`variant-${item.variantId}.jpg`),
    })));
    const contact = await fakeImage('source.png');
    return VisualReviewRequestSchema.parse({ ...original, artifacts, contactSheet: { relativePath: 'assets/source.png', sha256: contact.sha256 } });
  }

  async completeFakeJob(jobId: string): Promise<Readonly<JobSnapshot>> {
    const before = await this.snapshot(jobId);
    if (before.state !== 'running') throw new Error('fake job must be running to complete');
    super.publish(jobId);
    return this.snapshot(jobId);
  }

  metrics(jobId: string): { activeSubscriptions: number; eventCount: number; lastSequence: number } {
    const events = this.events(jobId);
    return { activeSubscriptions: this.activeSubscriptions.get(jobId) ?? 0, eventCount: events.length, lastSequence: events.at(-1)?.sequence ?? 0 };
  }
}
