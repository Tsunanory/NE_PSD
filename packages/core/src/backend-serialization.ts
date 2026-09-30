export class BackendSerialization {
  private static readonly byInstallation = new Map<string, BackendSerialization>();
  private busy = false;
  private blocked = false;
  static forInstallation(installationId: string): BackendSerialization {
    if (!installationId) throw new Error('trusted installation identity required');
    const existing = this.byInstallation.get(installationId);
    if (existing) return existing;
    const created = new BackendSerialization();
    this.byInstallation.set(installationId, created);
    return created;
  }
  block(): void { this.blocked = true; }
  clearBlocked(): void { this.blocked = false; }
  isBlocked(): boolean { return this.blocked; }
  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.blocked) throw Object.assign(new Error('Photoshop mutation is blocked pending positive recovery'), { code: 'MUTATION_BLOCKED' });
    if (this.busy) throw Object.assign(new Error('Photoshop mutation already in progress'), { code: 'MUTATION_IN_PROGRESS' });
    this.busy = true;
    try { return await operation(); } finally { this.busy = false; }
  }
  async runRecovery<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw Object.assign(new Error('Photoshop operation already in progress'), { code: 'MUTATION_IN_PROGRESS' });
    this.busy = true;
    this.blocked = true;
    try { return await operation(); } finally { this.busy = false; }
  }
}
