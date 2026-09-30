/// <reference types="node" />
import { mkdir, readFile, rm, writeFile, rename } from 'node:fs/promises';
import { join, normalize, relative, resolve, sep } from 'node:path';
import { OperationJournal, type JournalIdentity } from './recovery.js';

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
  unsettledOperations: number;
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
export type RecoveryAdoption = { operationId: string; ownershipToken: string; previousPid: number; previousProcessStartIdentity: string };
export class SessionLockError extends Error {
  constructor(public readonly code: 'CANCELLED' | 'LOCK_NOT_HELD' | 'RECOVERY_REQUIRED' | 'OWNERSHIP_MISMATCH', message: string) { super(message); this.name = 'SessionLockError'; }
}

const canonicalInstallation = (value: string): string => normalize(resolve(value));
const randomId = (): string => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const safeJournalPath = (lockPath: string, journalPath: string): boolean => {
  if (!journalPath || journalPath.includes('\0') || journalPath.split(/[\\/]+/).includes('..')) return false;
  const root = resolve(lockPath);
  const target = resolve(root, journalPath);
  const child = relative(root, target);
  return child === '' || (!child.startsWith('..') && !child.startsWith('/') && !child.includes(`..${sep}`));
};

function validMetadata(value: unknown): value is LockMetadata {
  if (!value || typeof value !== 'object') return false;
  const m = value as Record<string, unknown>;
  return m.schemaVersion === 1 && typeof m.hostId === 'string' && m.hostId.length > 0 && typeof m.installationPath === 'string' && typeof m.installationDigest === 'string' && /^[0-9a-f]{64}$/.test(m.installationDigest) && typeof m.pid === 'number' && Number.isInteger(m.pid) && typeof m.processStartIdentity === 'string' && m.processStartIdentity.length > 0 && typeof m.operationId === 'string' && m.operationId.length > 0 && typeof m.ownershipToken === 'string' && m.ownershipToken.length > 0 && typeof m.journalPath === 'string' && m.journalPath.length > 0 && typeof m.heartbeatAt === 'number' && typeof m.inFlight === 'number' && m.inFlight >= 0 && typeof m.unsettledOperations === 'number' && m.unsettledOperations >= 0 && typeof m.unknownMutation === 'boolean' && typeof m.reconciledJobOwnedDocuments === 'boolean';
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
  get journalMetadata(): LockMetadata | null { return this.owner ? { ...this.owner } : null; }
  get journalIdentity(): JournalIdentity | null {
    if (!this.owner) return null;
    return { jobId: this.owner.operationId, operationId: this.owner.operationId, hostId: this.owner.hostId, ownershipToken: this.owner.ownershipToken, installationDigest: this.owner.installationDigest };
  }
  operationJournal(): OperationJournal {
    const identity = this.journalIdentity ?? undefined;
    return new OperationJournal(this.owner?.journalPath, identity);
  }
  private installationPath(): string { return canonicalInstallation(this.options.installationPath); }
  private processStart(): string { return this.options.processStartIdentity; }

  async tryAcquire(input: AcquireOptions = {}): Promise<LockResult> {
    if (input.journalPath && !safeJournalPath(this.options.lockPath, input.journalPath)) return { acquired: false, reason: 'RECOVERY_REQUIRED' };
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
      unsettledOperations: 0,
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
    if (m.hostId !== this.options.hostId || m.installationPath !== this.installationPath() || m.installationDigest !== this.options.installationDigest || !safeJournalPath(this.options.lockPath, m.journalPath)) return { acquired: false, reason: 'RECOVERY_REQUIRED' };
    if (m.pid === (this.options.pid ?? process.pid) && m.processStartIdentity !== this.processStart()) return { acquired: false, reason: 'RECOVERY_REQUIRED' };
    const alive = this.options.isProcessAlive ? await this.options.isProcessAlive(m.pid) : true;
    return { acquired: false, reason: alive && !m.unknownMutation ? 'PHOTOSHOP_BUSY' : 'RECOVERY_REQUIRED' };
  }

  /** Explicit recovery-only adoption. Ordinary acquisition never adopts a stale owner. */
  async adoptRecovery(input: RecoveryAdoption): Promise<{ adopted: true; operationId: string; ownershipToken: string }> {
    if (this.owner) throw new SessionLockError('OWNERSHIP_MISMATCH', 'recovery owner is already active');
    let existing: unknown;
    try { existing = JSON.parse(await readFile(this.metadataPath(), 'utf8')); } catch { throw new SessionLockError('RECOVERY_REQUIRED', 'stale lock metadata is unavailable'); }
    if (!validMetadata(existing)) throw new SessionLockError('RECOVERY_REQUIRED', 'stale lock metadata is invalid');
    const prior = existing as LockMetadata;
    if (prior.hostId !== this.options.hostId || prior.installationPath !== this.installationPath() || prior.installationDigest !== this.options.installationDigest || !safeJournalPath(this.options.lockPath, prior.journalPath) || prior.operationId !== input.operationId || prior.ownershipToken !== input.ownershipToken || prior.pid !== input.previousPid || prior.processStartIdentity !== input.previousProcessStartIdentity) throw new SessionLockError('RECOVERY_REQUIRED', 'stale lock identity or ownership token does not match');
    const alive = this.options.isProcessAlive ? await this.options.isProcessAlive(prior.pid) : true;
    if (alive) throw new SessionLockError('RECOVERY_REQUIRED', 'the previous owner is still alive');
    const adopted = { ...prior, pid: this.options.pid ?? process.pid, processStartIdentity: this.processStart(), heartbeatAt: this.options.now() };
    // Serialize adoption and replace the metadata atomically. A stale-owner
    // read followed by an unconditional write could overwrite a new owner.
    const claimPath = `${this.options.lockPath}.transition`;
    try { await mkdir(claimPath); } catch { throw new SessionLockError('RECOVERY_REQUIRED', 'another recovery adoption is in progress'); }
    try {
      const current = JSON.parse(await readFile(this.metadataPath(), 'utf8')) as unknown;
      if (!validMetadata(current)) throw new SessionLockError('RECOVERY_REQUIRED', 'stale lock metadata changed or is invalid');
      const currentMetadata = current as LockMetadata;
      const identityMatches = currentMetadata.hostId === prior.hostId && currentMetadata.installationPath === prior.installationPath && currentMetadata.installationDigest === prior.installationDigest && currentMetadata.operationId === prior.operationId && currentMetadata.ownershipToken === prior.ownershipToken && currentMetadata.journalPath === prior.journalPath && currentMetadata.pid === prior.pid && currentMetadata.processStartIdentity === prior.processStartIdentity;
      if (!identityMatches) throw new SessionLockError('RECOVERY_REQUIRED', 'stale lock identity changed during adoption');
      const temporary = `${this.metadataPath()}.${this.options.randomToken()}.tmp`;
      await writeFile(temporary, JSON.stringify(adopted), 'utf8');
      await rename(temporary, this.metadataPath());
    } finally { await rm(claimPath, { recursive: true, force: true }); }
    this.owner = adopted;
    return { adopted: true, operationId: this.owner.operationId, ownershipToken: this.owner.ownershipToken };
  }

  async acquire(input: AcquireOptions = {}): Promise<Extract<LockResult, { acquired: true }>> {
    const result = await this.tryAcquire(input);
    if (!result.acquired) throw new SessionLockError(result.reason === 'RECOVERY_REQUIRED' ? 'RECOVERY_REQUIRED' : 'LOCK_NOT_HELD', result.reason);
    return result;
  }

  async release(): Promise<ReleaseResult> {
    const owner = this.owner;
    if (!owner) return { released: false, reason: 'OWNERSHIP_MISMATCH' };
    const transition = `${this.options.lockPath}.transition`;
    try { await mkdir(transition); } catch { return { released: false, reason: 'RECOVERY_REQUIRED' }; }
    try {
      let stored: unknown; try { stored = JSON.parse(await readFile(this.metadataPath(), 'utf8')); } catch { return { released: false, reason: 'RECOVERY_REQUIRED' }; }
      if (!validMetadata(stored)) return { released: false, reason: 'OWNERSHIP_MISMATCH' };
      const persisted = stored as LockMetadata;
      const identityMatches = persisted.hostId === owner.hostId && persisted.installationPath === owner.installationPath && persisted.installationDigest === owner.installationDigest && persisted.pid === owner.pid && persisted.processStartIdentity === owner.processStartIdentity && persisted.operationId === owner.operationId && persisted.ownershipToken === owner.ownershipToken && persisted.journalPath === owner.journalPath;
      if (!identityMatches) return { released: false, reason: 'OWNERSHIP_MISMATCH' };
      if (persisted.inFlight !== 0 || persisted.unsettledOperations !== 0 || persisted.unknownMutation || !persisted.reconciledJobOwnedDocuments) return { released: false, reason: 'RECOVERY_REQUIRED' };
      const tombstone = `${this.options.lockPath}.release-${owner.ownershipToken}`;
      await rename(this.options.lockPath, tombstone);
      this.owner = null;
      await rm(tombstone, { recursive: true, force: true });
      return { released: true };
    } finally { await rm(transition, { recursive: true, force: true }); }
  }

  async heartbeat(): Promise<void> { await this.update((m) => { m.heartbeatAt = this.options.now(); }); }
  async beginCall(): Promise<void> { await this.update((m) => { m.inFlight += 1; }); }
  async endCall(): Promise<void> { await this.update((m) => { m.inFlight = Math.max(0, m.inFlight - 1); }); }
  async markTransportPending(): Promise<void> { await this.update((m) => { m.unsettledOperations += 1; }); }
  async markTransportSettled(): Promise<void> { await this.update((m) => { m.unsettledOperations = Math.max(0, m.unsettledOperations - 1); }); }
  async markUnknownMutation(): Promise<void> { await this.update((m) => { m.unknownMutation = true; m.reconciledJobOwnedDocuments = false; }); }
  async reconcile(): Promise<void> {
    if (this.owner?.unsettledOperations !== 0) throw new SessionLockError('RECOVERY_REQUIRED', 'cannot reconcile while an underlying transport promise is unresolved');
    await this.update((m) => { m.unknownMutation = false; m.reconciledJobOwnedDocuments = true; });
    if (this.owner?.inFlight === 0) {
      const release = await this.release();
      if (!release.released) throw new SessionLockError('RECOVERY_REQUIRED', `reconciliation did not release the installation lock: ${release.reason}`);
    }
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
      if (safe) {
        const release = await this.release();
        if (!release.released) throw new SessionLockError('RECOVERY_REQUIRED', `safe recovery did not release the installation lock: ${release.reason}`);
      }
    }
  }

  async runExclusive<T>(operationId: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new SessionLockError('CANCELLED', 'operation cancelled while queued');
    const run = async (): Promise<T> => {
      if (signal?.aborted) throw new SessionLockError('CANCELLED', 'operation cancelled while queued');
      const acquired = await this.acquire({ operationId });
      await this.beginCall();
      let completed = false;
      try { const result = await fn(); completed = true; return result; } finally {
        await this.endCall();
        if (this.owner?.operationId === acquired.operationId && !this.owner.unknownMutation) {
          const release = await this.release();
          if (completed && !release.released) throw new SessionLockError('RECOVERY_REQUIRED', `operation completed without confirmed installation release: ${release.reason}`);
        }
        else if (completed) throw new SessionLockError('RECOVERY_REQUIRED', 'operation completed while installation ownership remains uncertain');
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
