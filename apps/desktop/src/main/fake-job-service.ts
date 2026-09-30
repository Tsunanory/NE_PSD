import { FakeJobService as ContractFakeJobService, loadFixture } from '@ne-psd/contracts/testing';
import { JobSpecSchema, type JobEvent, type JobSnapshot, type JobSpec } from '@ne-psd/contracts';

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
