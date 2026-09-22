export type LeaseDiagnostics = { host: string; pid: number; processStart: string; jobId: string; operation?: string };
export type PhotoshopLease = { acquire(jobId: string, diagnostics?: LeaseDiagnostics): Promise<void>; diagnostics(): Promise<LeaseDiagnostics>; release(): Promise<void>; retain(): Promise<void> };

export class BackendSerialization {
  private busy = false;
  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw Object.assign(new Error('Photoshop mutation already in progress'), { code: 'MUTATION_IN_PROGRESS' });
    this.busy = true;
    try { return await operation(); } finally { this.busy = false; }
  }
}
