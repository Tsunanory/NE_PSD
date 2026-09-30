import type { JobEvent, JobSnapshot } from '@ne-psd/contracts';

type Snapshot = JobSnapshot & { sequence?: number };
type Transport = {
  snapshot(jobId: string): Promise<Snapshot>;
  subscribe(jobId: string, listener: (event: JobEvent) => void): () => void;
  retryFailed?: (jobId: string) => Promise<{ jobId: string }>;
};

export class JobStore {
  private snapshotValue: Snapshot | undefined;
  private unsubscribe: (() => void) | undefined;
  private generation = 0;
  private lastSequence: number | undefined;
  private refreshing = false;
  error: string | null = null;
  private listeners = new Set<() => void>();
  private readonly transport: Transport;
  readonly previousJobs: JobSnapshot[] = [];
  jobId = '';

  constructor(transport: Transport) { this.transport = transport; }
  getSnapshot(): Snapshot | undefined { return this.snapshotValue; }
  listen(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(): void { for (const listener of this.listeners) listener(); }

  async connect(jobId: string): Promise<void> {
    if (!jobId) throw new Error('job ID is required');
    const generation = ++this.generation;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.jobId = jobId;
    this.snapshotValue = undefined;
    this.lastSequence = undefined;
    this.refreshing = false;
    this.error = null;
    this.emit();
    const queued: JobEvent[] = [];
    const unsubscribe = this.transport.subscribe(jobId, (event) => {
      if (generation !== this.generation || event.jobId !== jobId) return;
      if (!this.snapshotValue) queued.push(event);
      else this.accept(event, generation);
    });
    this.unsubscribe = unsubscribe;
    try {
      const fresh = await this.transport.snapshot(jobId);
      if (generation !== this.generation) return;
      this.setSnapshot(fresh, jobId);
      queued.sort((a, b) => a.sequence - b.sequence).forEach((event) => this.accept(event, generation));
    } catch (error) {
      if (generation === this.generation) { unsubscribe(); this.unsubscribe = undefined; this.error = error instanceof Error ? error.message : 'snapshot unavailable'; this.emit(); }
      throw error;
    }
  }

  private setSnapshot(snapshot: Snapshot, jobId: string): void {
    if (snapshot.jobId !== jobId) throw new Error('snapshot job ID mismatch');
    if (snapshot.sequence !== undefined) {
      if (!Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0) throw new Error('snapshot sequence is invalid');
      if (this.lastSequence !== undefined && snapshot.sequence < this.lastSequence) return;
      this.lastSequence = snapshot.sequence;
    }
    this.snapshotValue = Object.freeze(snapshot);
    this.emit();
  }

  private accept(event: JobEvent, generation: number): void {
    if (event.jobId !== this.jobId || event.snapshot.jobId !== this.jobId || !Number.isSafeInteger(event.sequence) || event.sequence < 0) return;
    if (this.lastSequence !== undefined && event.sequence <= this.lastSequence) return;
    if (this.lastSequence !== undefined && event.sequence !== this.lastSequence + 1) {
      if (!this.refreshing) void this.hydrate(generation, event.sequence).catch((error: unknown) => { if (generation === this.generation) { this.error = error instanceof Error ? error.message : 'snapshot unavailable'; this.emit(); } });
      return;
    }
    this.lastSequence = event.sequence;
    this.snapshotValue = Object.freeze({ ...event.snapshot, sequence: event.sequence });
    this.emit();
  }

  async hydrate(generation = this.generation, observedSequence?: number): Promise<void> {
    if (this.refreshing || !this.jobId) return;
    this.refreshing = true;
    const jobId = this.jobId;
    try {
      const fresh = await this.transport.snapshot(jobId);
      if (generation === this.generation) {
        this.setSnapshot(fresh, jobId);
        if (fresh.sequence === undefined && observedSequence !== undefined) this.lastSequence = observedSequence;
        this.error = null;
      }
    } finally { if (generation === this.generation) this.refreshing = false; }
  }

  async retry(): Promise<void> {
    if (!this.transport.retryFailed || !this.jobId) throw new Error('retry unavailable');
    const oldJobId = this.jobId;
    const successor = await this.transport.retryFailed(oldJobId);
    if (!successor.jobId || successor.jobId === oldJobId) throw new Error('retry successor ID is invalid');
    if (this.snapshotValue) this.previousJobs.push(this.snapshotValue);
    await this.connect(successor.jobId);
  }

  dispose(): void {
    this.generation++;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.listeners.clear();
  }
}

export function boundedAssetWindow<T>(items: readonly T[], start: number, size = 50): readonly T[] {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size) || size < 1) return [];
  return items.slice(Math.max(0, start), Math.max(0, start) + Math.min(size, 50));
}
