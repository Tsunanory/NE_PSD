export type LeaseDiagnostics = { host: string; pid: number; processStart: string; jobId: string; operation?: string };
export type PhotoshopLease = { acquire(jobId: string, diagnostics?: LeaseDiagnostics): Promise<void>; diagnostics(): Promise<LeaseDiagnostics>; release(): Promise<void>; retain(): Promise<void>; safeToRelease?: () => Promise<boolean> };

export class BackendSerialization {
  private static readonly byLease = new WeakMap<object, BackendSerialization>();
  private busy = false;
  private blocked = false;
  static forLease(lease: object): BackendSerialization { const existing = this.byLease.get(lease); if (existing) return existing; const created = new BackendSerialization(); this.byLease.set(lease, created); return created; }
  block(): void { this.blocked = true; }
  clearBlocked(): void { this.blocked = false; }
  isBlocked(): boolean { return this.blocked; }
  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.blocked) throw Object.assign(new Error('Photoshop mutation is blocked pending positive recovery'), { code: 'MUTATION_BLOCKED' });
    if (this.busy) throw Object.assign(new Error('Photoshop mutation already in progress'), { code: 'MUTATION_IN_PROGRESS' });
    this.busy = true;
    try { return await operation(); } finally { this.busy = false; }
  }
}
