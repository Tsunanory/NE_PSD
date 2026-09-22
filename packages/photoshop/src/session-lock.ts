/// <reference types="node" />
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, normalize, resolve } from 'node:path';

export type LockFailureReason = 'PHOTOSHOP_BUSY' | 'RECOVERY_REQUIRED' | 'OWNERSHIP_MISMATCH';
export type LockResult = { acquired: true; operationId: string; ownershipToken: string } | { acquired: false; reason: LockFailureReason };
export type ReleaseResult = { released: true } | { released: false; reason: LockFailureReason };

export type LockMetadata = {
  schemaVersion: 1;
  hostId: string;
  installationPath: string;
  installationDigest: string;
  pid: number;
  processStartIdentity: string;
  operationId: string;
  ownershipToken: string;
  journalPath: string;
  heartbeatAt: number;
  inFlight: number;
  unknownMutation: boolean;
  reconciledJobOwnedDocuments: boolean;
};

export type SessionLockOptions = {
  lockPath: string;
  installationPath: string;
  hostId: string;
  installationDigest: string;
  pid?: number;
  processStartIdentity: string;
  now?: () => number;
  randomToken?: () => string;
  isProcessAlive?: (pid: number) => boolean | Promise<boolean>;
};

export type AcquireOptions = { jobId?: string; operationId?: string; journalPath?: string };
export class SessionLockError extends Error {
  constructor(public readonly code: 'CANCELLED' | 'LOCK_NOT_HELD' | 'RECOVERY_REQUIRED', message: string) { super(message); this.name = 'SessionLockError'; }
}

const canonicalInstallation = (value: string): string => normalize(resolve(value));
const randomId = (): string => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;

function validMetadata(value: unknown): value is LockMetadata {
  if (!value || typeof value !== 'object') return false;
  const m = value as Record<string, unknown>;
  return m.schemaVersion === 1 && typeof m.hostId === 'string' && m.hostId.length > 0 && typeof m.installationPath === 'string' && typeof m.installationDigest === 'string' && /^[0-9a-f]{64}$/.test(m.installationDigest) && typeof m.pid === 'number' && Number.isInteger(m.pid) && typeof m.processStartIdentity === 'string' && m.processStartIdentity.length > 0 && typeof m.operationId === 'string' && m.operationId.length > 0 && typeof m.ownershipToken === 'string' && m.ownershipToken.length > 0 && typeof m.journalPath === 'string' && m.journalPath.length > 0 && typeof m.heartbeatAt === 'number' && typeof m.inFlight === 'number' && m.inFlight >= 0 && typeof m.unknownMutation === 'boolean' && typeof m.reconciledJobOwnedDocuments === 'boolean';
}

/** One OS-visible barrier for a Photoshop installation; heartbeat age never authorizes stealing. */
export class SessionLock {
  private readonly options: Required<Pick<SessionLockOptions, 'now' | 'randomToken'>> & SessionLockOptions;
  private owner: LockMetadata | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: SessionLockOptions) {
    if (!/^[0-9a-f]{64}$/.test(options.installationDigest)) throw new TypeError('installationDigest must be a lowercase SHA-256 hex digest');
    if (!options.processStartIdentity) throw new TypeError('processStartIdentity is required');
    this.options = { now: Date.now, randomToken: randomId, ...options };
  }

  private metadataPath(): string { return `${this.options.lockPath}/owner.json`; }
  get journalPath(): string { return this.owner?.journalPath ?? join(this.options.lockPath, 'journal', 'pending.jsonl'); }
  private installationPath(): string { return canonicalInstallation(this.options.installationPath); }
  private processStart(): string { return this.options.processStartIdentity; }

  async tryAcquire(input: AcquireOptions = {}): Promise<LockResult> {
    const operationId = input.operationId ?? input.jobId ?? `qualification-${randomId()}`;
    const token = this.options.randomToken();
    const metadata: LockMetadata = {
      schemaVersion: 1,
      hostId: this.options.hostId,
      installationPath: this.installationPath(),
      installationDigest: this.options.installationDigest,
      pid: this.options.pid ?? process.pid,
      processStartIdentity: this.processStart(),
      operationId,
      ownershipToken: token,
      journalPath: input.journalPath || join(this.options.lockPath, 'journal', `${operationId}.json`),
      heartbeatAt: this.options.now(),
      inFlight: 0,
      unknownMutation: false,
      reconciledJobOwnedDocuments: true,
    };
    try {
      await mkdir(this.options.lockPath);
      await writeFile(this.metadataPath(), JSON.stringify(metadata), { encoding: 'utf8', flag: 'wx' });
      this.owner = metadata;
      return { acquired: true, operationId, ownershipToken: token };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        await rm(this.options.lockPath, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    }
    let existing: unknown;
    try { existing = JSON.parse(await readFile(this.metadataPath(), 'utf8')); } catch { return { acquired: false, reason: 'RECOVERY_REQUIRED' }; }
    if (!validMetadata(existing)) return { acquired: false, reason: 'RECOVERY_REQUIRED' };
    const m = existing as LockMetadata;
    if (m.hostId !== this.options.hostId || m.installationPath !== this.installationPath() || m.installationDigest !== this.options.installationDigest) return { acquired: false, reason: 'RECOVERY_REQUIRED' };
    if (m.pid === (this.options.pid ?? process.pid) && m.processStartIdentity !== this.processStart()) return { acquired: false, reason: 'RECOVERY_REQUIRED' };
    const alive = this.options.isProcessAlive ? await this.options.isProcessAlive(m.pid) : true;
    return { acquired: false, reason: alive && !m.unknownMutation ? 'PHOTOSHOP_BUSY' : 'RECOVERY_REQUIRED' };
  }

  async acquire(input: AcquireOptions = {}): Promise<Extract<LockResult, { acquired: true }>> {
    const result = await this.tryAcquire(input);
    if (!result.acquired) throw new SessionLockError(result.reason === 'RECOVERY_REQUIRED' ? 'RECOVERY_REQUIRED' : 'LOCK_NOT_HELD', result.reason);
    return result;
  }

  async release(): Promise<ReleaseResult> {
    const owner = this.owner;
    let stored: unknown;
    try { stored = JSON.parse(await readFile(this.metadataPath(), 'utf8')); } catch { return { released: false, reason: 'RECOVERY_REQUIRED' }; }
    if (!validMetadata(stored) || !owner || (stored as LockMetadata).ownershipToken !== owner.ownershipToken) return { released: false, reason: 'OWNERSHIP_MISMATCH' };
    if (owner.inFlight !== 0 || owner.unknownMutation || !owner.reconciledJobOwnedDocuments) return { released: false, reason: 'RECOVERY_REQUIRED' };
    await rm(this.options.lockPath, { recursive: true, force: true });
    this.owner = null;
    return { released: true };
  }

  async heartbeat(): Promise<void> { await this.update((m) => { m.heartbeatAt = this.options.now(); }); }
  async beginCall(): Promise<void> { await this.update((m) => { m.inFlight += 1; }); }
  async endCall(): Promise<void> { await this.update((m) => { m.inFlight = Math.max(0, m.inFlight - 1); }); }
  async markUnknownMutation(): Promise<void> { await this.update((m) => { m.unknownMutation = true; m.reconciledJobOwnedDocuments = false; }); }
  async reconcile(): Promise<void> {
    await this.update((m) => { m.unknownMutation = false; m.reconciledJobOwnedDocuments = true; });
    if (this.owner?.inFlight === 0) await this.release();
  }
  async clearRecoveryBarrier(): Promise<void> { await this.reconcile(); }
  async markDocumentsUnreconciled(): Promise<void> { await this.update((m) => { m.reconciledJobOwnedDocuments = false; }); }

  /** Run reconciliation under the retained owner without acquiring a second lock. */
  async runRecovery<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!this.owner) throw new SessionLockError('RECOVERY_REQUIRED', 'recovery requires the retained installation owner');
    if (signal?.aborted) throw new SessionLockError('CANCELLED', 'recovery cancelled before dispatch');
    await this.beginCall();
    let result: T | undefined;
    try {
      result = await fn();
      return result;
    } finally {
      await this.endCall();
      const safe = result !== undefined && typeof result === 'object' && result !== null && (result as { safe?: unknown }).safe === true;
      if (safe && this.owner && !this.owner.unknownMutation && this.owner.reconciledJobOwnedDocuments) await this.release();
    }
  }

  async runExclusive<T>(operationId: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new SessionLockError('CANCELLED', 'operation cancelled while queued');
    const run = async (): Promise<T> => {
      if (signal?.aborted) throw new SessionLockError('CANCELLED', 'operation cancelled while queued');
      const acquired = await this.acquire({ operationId });
      await this.beginCall();
      try { return await fn(); } finally {
        await this.endCall();
        if (this.owner?.operationId === acquired.operationId && !this.owner.unknownMutation) await this.release();
      }
    };
    const result = this.queue.then(run, run);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async update(change: (metadata: LockMetadata) => void): Promise<void> {
    if (!this.owner) throw new SessionLockError('LOCK_NOT_HELD', 'session lock is not held');
    change(this.owner);
    await writeFile(this.metadataPath(), JSON.stringify(this.owner), 'utf8');
  }
}
