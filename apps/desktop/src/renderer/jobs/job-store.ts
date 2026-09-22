import type { JobEvent, JobSnapshot } from '@ne-psd/contracts';
type Snapshot = JobSnapshot & { sequence: number };
type Transport = { snapshot(jobId: string): Promise<Snapshot>; subscribe(jobId: string, listener: (event: JobEvent) => void): () => void; retryFailed?: (jobId: string) => Promise<{ jobId: string }> };
export class JobStore {
  private snapshotValue: Snapshot | undefined; private unsubscribe: (() => void) | undefined; private transport: Transport; jobId = '';
  constructor(transport: Transport) { this.transport = transport; }
  getSnapshot(): Snapshot | undefined { return this.snapshotValue; }
  async connect(jobId: string): Promise<void> { this.unsubscribe?.(); this.unsubscribe = undefined; this.jobId = jobId; this.snapshotValue = await this.transport.snapshot(jobId); this.unsubscribe = this.transport.subscribe(jobId, (event) => { if (event.jobId !== this.jobId || event.sequence <= (this.snapshotValue?.sequence ?? -1)) return; if (event.sequence !== (this.snapshotValue?.sequence ?? -1) + 1) { void this.hydrate(); return; } this.snapshotValue = Object.freeze({ ...event.snapshot, sequence: event.sequence }); }); }
  async hydrate(): Promise<void> { this.snapshotValue = await this.transport.snapshot(this.jobId); }
  async retry(): Promise<void> { if (!this.transport.retryFailed) throw new Error('retry unavailable'); const successor = await this.transport.retryFailed(this.jobId); this.unsubscribe?.(); this.unsubscribe = undefined; await this.connect(successor.jobId); }
  dispose(): void { this.unsubscribe?.(); this.unsubscribe = undefined; }
}
export function boundedAssetWindow<T>(items: readonly T[], start: number, size = 50): readonly T[] { return items.slice(Math.max(0, start), Math.max(0, start) + size); }
