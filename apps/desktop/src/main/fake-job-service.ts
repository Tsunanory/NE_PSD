import { FakeJobService as ContractFakeJobService, fixtureRoot, loadFixture } from '@ne-psd/contracts/testing';
import { JobSpecSchema, VisualReviewRequestSchema, type JobEvent, type JobSnapshot, type JobSpec, type VisualReviewRequest } from '@ne-psd/contracts';
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

  override subscribe(jobId: string, listener: (event: JobEvent) => void): () => void {
    const unsubscribe = super.subscribe(jobId, listener);
    this.activeSubscriptions.set(jobId, (this.activeSubscriptions.get(jobId) ?? 0) + 1);
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      this.activeSubscriptions.set(jobId, (this.activeSubscriptions.get(jobId) ?? 1) - 1);
    };
  }

  override async snapshot(jobId: string): Promise<Readonly<JobSnapshot>> {
    return freezeDeep(await super.snapshot(jobId));
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
