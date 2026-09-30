import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import type { OperationKind } from './types.js';

export type RecoveryCategory = 'ambiguousState' | 'cancelled' | 'transient' | 'validation';

export class RecoveryError extends Error {
  readonly name = 'RecoveryError';
  constructor(
    readonly code: string,
    message: string,
    readonly category: RecoveryCategory,
    readonly retryable: boolean,
    readonly evidencePaths: readonly string[] = [],
  ) {
    super(message);
  }
}

export type JournalState = 'issued' | 'acknowledged' | 'failedSafe' | 'unknown' | 'reconciled';
export type JournalIdentity = { jobId: string; operationId: string; hostId: string; ownershipToken: string; installationDigest: string };
export type JournalEntry = {
  schemaVersion: 1;
  sequence: number;
  timestamp: string;
  operation: string;
  requestId: string;
  mutation: boolean;
  state: JournalState;
  jobId: string;
  operationId: string;
  hostId: string;
  ownershipToken: string;
  installationDigest: string;
  previousDigest: string | null;
  digest: string;
  reason?: string;
};

const defaultIdentity: JournalIdentity = { jobId: 'unknown-job', operationId: 'unknown-operation', hostId: 'unknown-host', ownershipToken: 'unknown-token', installationDigest: '0'.repeat(64) };
type JournalUnsigned = Omit<JournalEntry, 'digest'>;
type JournalDraft = Omit<JournalEntry, 'schemaVersion' | 'sequence' | 'timestamp' | 'jobId' | 'operationId' | 'hostId' | 'ownershipToken' | 'installationDigest' | 'previousDigest' | 'digest'>;
const digestOf = (entry: JournalUnsigned): string => createHash('sha256').update(JSON.stringify(entry)).digest('hex');
const validDigest = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const OPERATIONS = new Set<OperationKind>([
  'listDocuments', 'readDocument', 'readLayers', 'readLinkage', 'openDocument', 'activateDocument', 'selectLayer', 'openContents',
  'place', 'replaceContents', 'scale', 'translate', 'moveAbove', 'setClipping', 'setVisibility', 'saveChild', 'closeDiscard',
  'export', 'convertProfile', 'embedLink', 'relink',
]);
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

function validateEntry(value: unknown, previous: JournalEntry | undefined, identity: JournalIdentity, states: Map<string, JournalState>): JournalEntry {
  if (!value || typeof value !== 'object') throw new RecoveryError('JOURNAL_CORRUPT', 'journal entry is not an object', 'ambiguousState', false);
  const entry = value as Partial<JournalEntry>;
  const allowed = new Set(['schemaVersion', 'sequence', 'timestamp', 'operation', 'requestId', 'mutation', 'state', 'jobId', 'operationId', 'hostId', 'ownershipToken', 'installationDigest', 'previousDigest', 'digest', 'reason']);
  if (Object.keys(entry).some((key) => !allowed.has(key))) throw new RecoveryError('JOURNAL_CORRUPT', 'journal entry contains unknown fields', 'ambiguousState', false);
  if (entry.schemaVersion !== 1 || !Number.isInteger(entry.sequence) || Number(entry.sequence) <= 0 || !entry.timestamp || !Number.isFinite(Date.parse(entry.timestamp)) || !nonEmpty(entry.operation) || !OPERATIONS.has(entry.operation as OperationKind) || !nonEmpty(entry.requestId) || typeof entry.mutation !== 'boolean' || !['issued', 'acknowledged', 'failedSafe', 'unknown', 'reconciled'].includes(String(entry.state)) || !nonEmpty(entry.jobId) || !nonEmpty(entry.operationId) || !nonEmpty(entry.hostId) || !nonEmpty(entry.ownershipToken) || !validDigest(entry.installationDigest) || (entry.previousDigest !== null && !validDigest(entry.previousDigest)) || !validDigest(entry.digest) || (entry.reason !== undefined && !nonEmpty(entry.reason))) throw new RecoveryError('JOURNAL_CORRUPT', 'journal entry schema is invalid', 'ambiguousState', false);
  if (!previous && entry.sequence !== 1) throw new RecoveryError('JOURNAL_CORRUPT', 'journal must begin at sequence 1', 'ambiguousState', false);
  if (previous && entry.sequence !== previous.sequence + 1) throw new RecoveryError('JOURNAL_CORRUPT', 'journal sequence is not monotonic', 'ambiguousState', false);
  if (previous && entry.previousDigest !== previous.digest) throw new RecoveryError('JOURNAL_CORRUPT', 'journal digest chain is broken', 'ambiguousState', false);
  if (!previous && entry.previousDigest !== null) throw new RecoveryError('JOURNAL_CORRUPT', 'journal has an unexpected predecessor', 'ambiguousState', false);
  if (entry.jobId !== identity.jobId || entry.operationId !== identity.operationId || entry.hostId !== identity.hostId || entry.ownershipToken !== identity.ownershipToken || entry.installationDigest !== identity.installationDigest) throw new RecoveryError('JOURNAL_IDENTITY_MISMATCH', 'journal identity does not match the acquired operation lock', 'ambiguousState', false);
  const priorState = states.get(entry.requestId);
  if (!priorState && entry.state !== 'issued') throw new RecoveryError('JOURNAL_TRANSITION_INVALID', 'journal operation must begin with issued', 'ambiguousState', false);
  if (priorState && !((priorState === 'issued' && ['acknowledged', 'failedSafe', 'unknown'].includes(String(entry.state))) || (priorState === 'unknown' && entry.state === 'reconciled'))) throw new RecoveryError(priorState === 'issued' ? 'JOURNAL_DUPLICATE_REQUEST' : 'JOURNAL_TRANSITION_INVALID', 'journal state transition is illegal', 'ambiguousState', false);
  const candidate = entry as JournalEntry;
  const { digest, ...unsigned } = candidate;
  if (digestOf(unsigned) !== digest) throw new RecoveryError('JOURNAL_CORRUPT', 'journal entry digest does not match content', 'ambiguousState', false);
  states.set(candidate.requestId, candidate.state);
  return candidate;
}

export class OperationJournal {
  private readonly entries: JournalEntry[] = [];
  private readonly requests = new Map<string, { operation: string; mutation: boolean }>();
  private sequence = 0;
  private writeQueue: Promise<void> = Promise.resolve();

  private currentPath: string | undefined;
  private readonly identityValue: JournalIdentity;
  private unsettledRequests = new Set<string>();
  constructor(filePath?: string, identity?: Partial<JournalIdentity>) {
    this.currentPath = filePath;
    this.identityValue = {
      jobId: identity?.jobId ?? defaultIdentity.jobId,
      operationId: identity?.operationId ?? defaultIdentity.operationId,
      hostId: identity?.hostId ?? defaultIdentity.hostId,
      ownershipToken: identity?.ownershipToken ?? defaultIdentity.ownershipToken,
      installationDigest: identity?.installationDigest ?? defaultIdentity.installationDigest,
    };
  }
  get filePath(): string | undefined { return this.currentPath; }
  get identity(): JournalIdentity { return { ...this.identityValue }; }
  bindPath(filePath: string): void {
    if (this.unsettledRequests.size > 0 && this.currentPath && this.currentPath !== filePath) throw new RecoveryError('JOURNAL_PATH_CHANGE_UNSAFE', 'journal path cannot change while a transport promise is unresolved', 'ambiguousState', false);
    this.currentPath = filePath;
  }
  bindIdentity(identity: Partial<JournalIdentity>): void {
    if (this.entries.length > 0 && Object.entries(identity).some(([key, value]) => value !== undefined && value !== this.identityValue[key as keyof JournalIdentity])) throw new RecoveryError('JOURNAL_IDENTITY_CHANGE_UNSAFE', 'journal identity cannot change after append', 'ambiguousState', false);
    for (const key of ['jobId', 'operationId', 'hostId', 'ownershipToken', 'installationDigest'] as const) if (identity[key] !== undefined) this.identityValue[key] = identity[key];
  }

  async issued(input: { operation: string; requestId: string; mutation: boolean }): Promise<JournalEntry> {
    this.requests.set(input.requestId, { operation: input.operation, mutation: input.mutation });
    return this.append({ ...input, state: 'issued' });
  }

  async acknowledged(requestId: string): Promise<JournalEntry> {
    return this.append({ ...this.requestMeta(requestId), requestId, state: 'acknowledged' });
  }

  async failedSafe(requestId: string, reason: string): Promise<JournalEntry> {
    return this.append({ ...this.requestMeta(requestId), requestId, state: 'failedSafe', reason });
  }

  async unknown(requestId: string, reason: string): Promise<JournalEntry> {
    return this.append({ ...this.requestMeta(requestId), requestId, state: 'unknown', reason });
  }

  async reconciled(requestId: string): Promise<JournalEntry> {
    return this.append({ ...this.requestMeta(requestId), requestId, state: 'reconciled' });
  }

  async read(allowMissing = false): Promise<JournalEntry[]> {
    if (this.currentPath) {
      try {
        const text = await readFile(this.currentPath, 'utf8');
        const parsed: JournalEntry[] = [];
        const states = new Map<string, JournalState>();
        const requestMeta = new Map<string, { operation: string; mutation: boolean }>();
        for (const line of text.split('\n').filter(Boolean)) {
          let decoded: unknown;
          try { decoded = JSON.parse(line); } catch { throw new RecoveryError('JOURNAL_CORRUPT', 'journal contains malformed JSON', 'ambiguousState', false); }
          const candidate = validateEntry(decoded, parsed.at(-1), this.identityValue, states);
          const prior = requestMeta.get(candidate.requestId);
          if (prior && (prior.operation !== candidate.operation || prior.mutation !== candidate.mutation)) throw new RecoveryError('JOURNAL_METADATA_DRIFT', 'journal request metadata changed across terminal records', 'ambiguousState', false);
          requestMeta.set(candidate.requestId, { operation: candidate.operation, mutation: candidate.mutation });
          parsed.push(candidate);
        }
        this.entries.splice(0, this.entries.length, ...parsed);
        this.sequence = parsed.reduce((max, entry) => Math.max(max, Number(entry.sequence)), this.sequence);
        for (const entry of parsed) this.requests.set(entry.requestId, { operation: entry.operation, mutation: entry.mutation });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && allowMissing) return this.entries.map((entry) => ({ ...entry }));
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new RecoveryError('JOURNAL_MISSING', 'persisted journal is missing', 'ambiguousState', false);
        if (error instanceof RecoveryError) throw error;
        throw new RecoveryError('JOURNAL_CORRUPT', 'journal could not be parsed or read', 'ambiguousState', false);
      }
    }
    return this.entries.map((entry) => ({ ...entry }));
  }

  pendingUnknown(): string[] {
    const pending = new Set<string>();
    for (const entry of this.entries) {
      if (entry.state === 'issued' || entry.state === 'unknown') pending.add(entry.requestId);
      if (entry.state === 'acknowledged' || entry.state === 'failedSafe' || entry.state === 'reconciled') pending.delete(entry.requestId);
    }
    return [...pending];
  }

  async reconcile(requestId?: string): Promise<void> {
    if (this.unsettledRequests.size > 0) throw new RecoveryError('UNSETTLED_OPERATION', 'cannot reconcile while an underlying transport promise is unresolved', 'ambiguousState', false);
    const ids = requestId ? [requestId] : this.pendingUnknown();
    for (const id of ids) await this.reconciled(id);
  }

  track(requestId: string, promise: Promise<unknown>): void {
    this.unsettledRequests.add(requestId);
    void promise.then(() => this.unsettledRequests.delete(requestId), () => this.unsettledRequests.delete(requestId));
  }
  unsettled(): string[] { return [...this.unsettledRequests]; }

  private async append(input: JournalDraft): Promise<JournalEntry> {
    if (!OPERATIONS.has(input.operation as OperationKind) || !nonEmpty(input.requestId) || (input.reason !== undefined && !nonEmpty(input.reason))) throw new RecoveryError('JOURNAL_CORRUPT', 'journal append contains invalid operation metadata', 'ambiguousState', false);
    if (this.currentPath && this.entries.length === 0 && this.sequence === 0) await this.read(true);
    const priorState = this.entries.filter((entry) => entry.requestId === input.requestId).at(-1)?.state;
    if (!priorState && input.state !== 'issued') throw new RecoveryError('JOURNAL_TRANSITION_INVALID', 'journal operation must begin with issued', 'ambiguousState', false);
    if (priorState && !((priorState === 'issued' && ['acknowledged', 'failedSafe', 'unknown'].includes(input.state)) || (priorState === 'unknown' && input.state === 'reconciled'))) throw new RecoveryError('JOURNAL_TRANSITION_INVALID', 'journal state transition is illegal', 'ambiguousState', false);
    const unsigned: JournalUnsigned = { ...input, schemaVersion: 1 as const, ...this.identityValue, sequence: ++this.sequence, timestamp: new Date().toISOString(), previousDigest: this.entries.at(-1)?.digest ?? null };
    const entry: JournalEntry = { ...unsigned, digest: digestOf(unsigned) };
    this.entries.push(entry);
    this.writeQueue = this.writeQueue.then(async () => {
      if (!this.currentPath) return;
      await mkdir(dirname(this.currentPath), { recursive: true });
      const handle = await open(this.currentPath, 'a');
      try { await handle.write(`${JSON.stringify(entry)}\n`); await handle.sync(); }
      finally { await handle.close(); }
      try { const directory = await open(dirname(this.currentPath), 'r'); try { await directory.sync(); } finally { await directory.close(); } }
      catch (error) { const code = (error as NodeJS.ErrnoException).code; if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes(String(code))) throw error; }
    });
    await this.writeQueue;
    return { ...entry };
  }

  private requestMeta(requestId: string): { operation: string; mutation: boolean } {
    return this.requests.get(requestId) ?? { operation: 'unknown', mutation: false };
  }
}

const READ_TIMEOUT = 15_000;
const OPEN_TIMEOUT = 120_000;
const MUTATION_TIMEOUT = 120_000;
const SAVE_EXPORT_TIMEOUT = 180_000;

export function operationTimeoutMs(operation: string): number {
  if (operation === 'saveChild' || operation === 'export') return SAVE_EXPORT_TIMEOUT;
  if (operation === 'listDocuments' || operation === 'readDocument' || operation === 'readLayers' || operation === 'readLinkage' || operation === 'activateDocument' || operation === 'selectLayer') return READ_TIMEOUT;
  if (operation === 'openDocument' || operation === 'openContents' || operation === 'place' || operation === 'replaceContents' || operation === 'scale' || operation === 'translate' || operation === 'moveAbove' || operation === 'setClipping' || operation === 'setVisibility' || operation === 'closeDiscard') return OPEN_TIMEOUT;
  return READ_TIMEOUT;
}

type OperationCall<T> = {
  operation: string;
  requestId: string;
  mutation: boolean;
  call: () => Promise<T>;
  journal: OperationJournal;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  onDispatch?: (() => void | Promise<void>) | undefined;
  onSettled?: (() => void | Promise<void>) | undefined;
  onUnknown?: (() => void | Promise<void>) | undefined;
};

function cancellation(signal: AbortSignal, afterDispatch: boolean): RecoveryError {
  return afterDispatch
    ? new RecoveryError('CANCELLED_AFTER_DISPATCH', 'operation caller cancelled after dispatch; Photoshop state is unknown', 'ambiguousState', false)
    : new RecoveryError('CANCELLED', 'operation cancelled before dispatch', 'cancelled', false);
}

/** Dispatches exactly once. A timeout never aborts the underlying transport call. */
export async function runUncertainOperation<T>(options: OperationCall<T>): Promise<T> {
  if (options.signal?.aborted) throw cancellation(options.signal, false);
  await options.journal.issued({ operation: options.operation, requestId: options.requestId, mutation: options.mutation });
  if (options.signal?.aborted) {
    await options.journal.failedSafe(options.requestId, 'cancelled before dispatch');
    throw cancellation(options.signal, false);
  }

  let dispatched = false;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  let rejectRace!: (error: unknown) => void;
  const raceSignal = new Promise<never>((_, reject) => { rejectRace = reject; });
  const callPromise = Promise.resolve().then(async () => {
    // The dispatch phase includes durable bookkeeping. Mark it as in-flight
    // before onDispatch so a timeout cannot release the installation lock
    // while that callback may still reach the transport.
    dispatched = true;
    await options.onDispatch?.();
    // A timeout may win while onDispatch is still flushing the lock/journal.
    // Do not let that late callback dispatch a mutation after the caller has
    // already received an ambiguous timeout.
    if (timedOut) throw new RecoveryError('OPERATION_TIMEOUT', `${options.operation} timed out before dispatch completed`, 'ambiguousState', false);
    if (options.signal?.aborted) throw cancellation(options.signal, false);
    return options.call();
  });
  callPromise.catch(() => undefined);
  void callPromise.then(() => options.onSettled?.(), () => options.onSettled?.()).catch(() => undefined);
  options.journal.track(options.requestId, callPromise);
  const timeoutMs = options.timeoutMs ?? operationTimeoutMs(options.operation);
  timer = setTimeout(() => { timedOut = true; rejectRace(new RecoveryError('OPERATION_TIMEOUT', `${options.operation} exceeded its ${timeoutMs}ms failure-detection ceiling`, 'ambiguousState', false)); }, timeoutMs);
  if (options.signal) {
    abortListener = () => rejectRace(cancellation(options.signal!, dispatched));
    options.signal.addEventListener('abort', abortListener, { once: true });
  }

  try {
    const result = await Promise.race([callPromise, raceSignal]);
    try { await options.journal.acknowledged(options.requestId); }
    catch (error) {
      let barrierError: unknown;
      try { await options.onUnknown?.(); } catch (cause) { barrierError = cause; }
      throw new RecoveryError('JOURNAL_WRITE_FAILED', `acknowledgement journal append failed${barrierError ? '; recovery barrier was also unavailable' : ''}`, 'ambiguousState', false);
    }
    return result as T;
  } catch (error) {
    const ambiguous = dispatched && (error instanceof RecoveryError ? error.category === 'ambiguousState' : true);
    if (ambiguous) {
      const reason = error instanceof Error ? error.message : String(error);
      let journalError: unknown;
      try { await options.journal.unknown(options.requestId, reason); } catch (cause) { journalError = cause; }
      let barrierError: unknown;
      try { await options.onUnknown?.(); } catch (cause) { barrierError = cause; }
      if (journalError || barrierError) throw new RecoveryError('JOURNAL_WRITE_FAILED', `unknown operation state could not be durably journaled${barrierError ? '; recovery barrier update also failed' : ''}`, 'ambiguousState', false);
      if (error instanceof RecoveryError && error.category === 'ambiguousState') throw error;
      throw new RecoveryError('TRANSPORT_AMBIGUOUS', `${options.operation} acknowledgement is unknown`, 'ambiguousState', false);
    }
    try { await options.journal.failedSafe(options.requestId, error instanceof Error ? error.message : String(error)); }
    catch { throw new RecoveryError('JOURNAL_WRITE_FAILED', 'safe failure could not be durably journaled', 'ambiguousState', false); }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (options.signal && abortListener) options.signal.removeEventListener('abort', abortListener);
  }
}

export type RecoveryIdentity = JournalIdentity & { jobRoot: string };
export type RecoveryOwnershipRecord = { documentId: string; jobId: string; operationId: string; hostId: string; ownershipToken: string; installationDigest: string; path: string; parentId: string | null; depth: number };
export type RecoveryDocument = { id: string; path: string | null; owned: boolean; dirty: boolean; parentId: string | null; depth?: number };
export type RecoveryRuntime = {
  journal: { read: () => Promise<JournalEntry[]>; filePath?: string };
  journalPath?: string;
  listDocuments: () => Promise<readonly RecoveryDocument[]>;
  isIdle: () => Promise<boolean>;
  safeCompletion?: () => Promise<boolean>;
  verifyOriginals: () => Promise<boolean>;
  closeDiscard: (documentId: string) => Promise<void>;
  evidencePaths?: readonly string[];
  identity?: RecoveryIdentity;
  ownershipLedger?: readonly RecoveryOwnershipRecord[];
  operationJournal?: OperationJournal;
  timeoutMs?: number;
  timeouts?: Partial<Record<string, number>>;
  onUnknown?: () => void | Promise<void>;
  clearPendingOperations?: () => void | Promise<void>;
};

export type RecoveryResult = { safe: boolean; evidencePaths: string[]; outstanding: string[]; ambiguous?: boolean; error?: { code: string; category: 'ambiguousState' | 'validation'; retryable: false; evidencePaths: string[] } };

const recoveryEvidence = (runtime: RecoveryRuntime): string[] => [...(runtime.evidencePaths ?? [])];
const insideRoot = (root: string, path: string): boolean => {
  if (!root || !path || path.includes('\0')) return false;
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  const child = relative(resolvedRoot, resolvedPath);
  return child === '' || (!child.startsWith('..') && !child.startsWith('/') && !child.includes(`..${sep}`));
};

async function ownedPathInside(root: string, path: string): Promise<boolean> {
  if (!insideRoot(root, path)) return false;
  try {
    if ((await lstat(root)).isSymbolicLink()) return false;
    let current = resolve(root);
    for (const component of relative(current, resolve(path)).split(sep).filter(Boolean)) {
      current = resolve(current, component);
      if ((await lstat(current)).isSymbolicLink()) return false;
    }
    return insideRoot(await realpath(root), await realpath(path));
  } catch { return false; }
}

function invalidRecovery(runtime: RecoveryRuntime, outstanding: string[], code: string, message: string, ambiguous = false): RecoveryResult {
  return { safe: false, evidencePaths: recoveryEvidence(runtime), outstanding, ...(ambiguous ? { ambiguous: true } : {}), error: { code, category: ambiguous ? 'ambiguousState' : 'validation', retryable: false, evidencePaths: recoveryEvidence(runtime) } };
}

/** Reconciles state only; it never replays the journal's mutation records. */
export async function recoverJob(_jobId: string, runtime: RecoveryRuntime, signal: AbortSignal): Promise<RecoveryResult> {
  const identity = runtime.identity;
  if (!identity || identity.jobId !== _jobId || !identity.operationId || !identity.hostId || !identity.ownershipToken || !validDigest(identity.installationDigest) || !identity.jobRoot) return invalidRecovery(runtime, ['ownership-identity-missing'], 'RECOVERY_OWNERSHIP_MISMATCH', 'recovery requires a matching persisted job and installation identity');
  const persistedJournalPath = runtime.operationJournal?.filePath ?? runtime.journalPath ?? runtime.journal.filePath;
  if (!persistedJournalPath) return invalidRecovery(runtime, ['journal-path-missing'], 'JOURNAL_PERSISTENCE_REQUIRED', 'recovery requires a persisted runtime journal path');
  if (runtime.operationJournal && Object.entries(runtime.operationJournal.identity).some(([key, value]) => value !== identity[key as keyof JournalIdentity])) return invalidRecovery(runtime, ['journal-identity-mismatch'], 'JOURNAL_IDENTITY_MISMATCH', 'runtime journal identity differs from recovery owner', true);
  const primitiveJournal = runtime.operationJournal ?? new OperationJournal(persistedJournalPath, identity);
  const guard = async <T>(operation: string, call: () => Promise<T>): Promise<T> => runUncertainOperation({ operation, requestId: `recovery-${operation}-${globalThis.crypto.randomUUID()}`, mutation: operation === 'closeDiscard', journal: primitiveJournal, timeoutMs: runtime.timeouts?.[operation] ?? runtime.timeoutMs ?? operationTimeoutMs(operation), signal, onUnknown: runtime.onUnknown, call });
  if (signal.aborted) return invalidRecovery(runtime, ['cancelled'], 'CANCELLED', 'recovery cancelled before dispatch');
  let entries: JournalEntry[];
  // Journal bytes are the persisted authority and must be read before adding
  // recovery's own primitive records; otherwise the read guard would make
  // its synthetic issued record look like an unresolved user operation.
  try { entries = await primitiveJournal.read(); }
  catch (error) { if (error instanceof RecoveryError && error.category === 'ambiguousState') return invalidRecovery(runtime, ['journal-read-failed'], error.code, error.message, true); return invalidRecovery(runtime, ['journal-read-failed'], 'JOURNAL_READ_FAILED', 'journal could not be read'); }
  if (entries.length === 0) return invalidRecovery(runtime, ['journal-empty'], 'JOURNAL_PROOF_MISSING', 'empty journal is not persisted operation proof', true);
  if (entries.some((entry) => entry.jobId !== identity.jobId || entry.operationId !== identity.operationId || entry.hostId !== identity.hostId || entry.ownershipToken !== identity.ownershipToken || entry.installationDigest !== identity.installationDigest)) return invalidRecovery(runtime, ['journal-identity-mismatch'], 'JOURNAL_IDENTITY_MISMATCH', 'journal operation identity does not match recovery owner');
  const outstanding = new Set<string>();
  for (const entry of entries) {
    if (entry.state === 'issued' || entry.state === 'unknown') outstanding.add(entry.requestId);
    if (entry.state === 'acknowledged' || entry.state === 'failedSafe' || entry.state === 'reconciled') outstanding.delete(entry.requestId);
  }
  try {
    if (!(await guard('readDocument', runtime.isIdle))) return invalidRecovery(runtime, [...outstanding, 'idle-proof-failed'], 'IDLE_PROOF_FAILED', 'Photoshop is not independently proven idle');
    if (outstanding.size > 0 && (!runtime.safeCompletion || !(await guard('readDocument', runtime.safeCompletion)))) return invalidRecovery(runtime, [...outstanding, 'safe-completion-failed'], 'SAFE_COMPLETION_UNPROVEN', 'unknown operations lack a qualified safe-completion proof');
  } catch (error) { if (error instanceof RecoveryError && error.category === 'ambiguousState') return invalidRecovery(runtime, [...outstanding, 'idle-proof-failed'], error.code, error.message, true); return invalidRecovery(runtime, [...outstanding, 'idle-proof-failed'], 'IDLE_PROOF_FAILED', 'idle proof failed'); }
  if (outstanding.size > 0) {
    if (!runtime.clearPendingOperations) return invalidRecovery(runtime, [...outstanding, 'pending-operations-unresolved'], 'PENDING_OPERATIONS_UNRESOLVED', 'safe completion did not clear pending transport operations');
    try {
      await runtime.clearPendingOperations();
      await primitiveJournal.reconcile();
      const persisted = await new OperationJournal(persistedJournalPath, identity).read();
      const terminal = new Map(persisted.map((entry) => [entry.requestId, entry.state]));
      if ([...outstanding].some((id) => terminal.get(id) !== 'reconciled') || persisted.some((entry) => entry.state === 'issued' || entry.state === 'unknown' ? terminal.get(entry.requestId) === entry.state : false)) throw new RecoveryError('PENDING_OPERATIONS_UNRESOLVED', 'persisted journal does not prove terminal reconciliation', 'ambiguousState', false);
    } catch (error) { return invalidRecovery(runtime, [...outstanding, 'pending-operations-unresolved'], error instanceof RecoveryError ? error.code : 'PENDING_OPERATIONS_UNRESOLVED', 'pending operations could not be durably reconciled', true); }
  }
  let documents: RecoveryDocument[];
  try { documents = [...await guard('readLayers', runtime.listDocuments)]; } catch (error) { if (error instanceof RecoveryError && error.category === 'ambiguousState') return invalidRecovery(runtime, [...outstanding, 'document-inventory-failed'], error.code, error.message, true); return invalidRecovery(runtime, [...outstanding, 'document-inventory-failed'], 'DOCUMENT_INVENTORY_FAILED', 'document inventory failed'); }
  const ledger = new Map((runtime.ownershipLedger ?? []).map((record) => [record.documentId, record]));
  const owned = documents.filter((document) => document.owned);
  const ownedDocument = (id: string): boolean => {
    const document = documents.find((candidate) => candidate.id === id);
    const proof = ledger.get(id);
    return Boolean(document?.owned && proof && proof.jobId === identity.jobId && proof.operationId === identity.operationId && proof.hostId === identity.hostId && proof.ownershipToken === identity.ownershipToken && proof.installationDigest === identity.installationDigest);
  };
  for (const proof of ledger.values()) {
    const document = documents.find((candidate) => candidate.id === proof.documentId);
    if (!document || !document.owned || !await ownedPathInside(identity.jobRoot, proof.path)) return invalidRecovery(runtime, [...outstanding, `ownership-ledger-mismatch:${proof.documentId}`], 'OWNERSHIP_LEDGER_MISMATCH', 'persisted ownership ledger does not match the live document inventory');
  }
  for (const document of owned) {
    const proof = ledger.get(document.id);
    if (!proof || proof.jobId !== identity.jobId || proof.operationId !== identity.operationId || proof.hostId !== identity.hostId || proof.ownershipToken !== identity.ownershipToken || proof.installationDigest !== identity.installationDigest || !document.path || resolve(document.path) !== resolve(proof.path) || document.parentId !== proof.parentId || (document.depth ?? -1) !== proof.depth || !await ownedPathInside(identity.jobRoot, proof.path) || (document.parentId !== null && !ownedDocument(document.parentId))) return invalidRecovery(runtime, [...outstanding, `ownership-unproven:${document.id}`], 'DOCUMENT_OWNERSHIP_UNPROVEN', 'document ownership, path, parent, or depth could not be proven');
    if (document.parentId !== null) {
      const parent = documents.find((candidate) => candidate.id === document.parentId);
      if (!parent || !ownedDocument(parent.id) || (parent.depth ?? -1) >= (document.depth ?? -1)) return invalidRecovery(runtime, [...outstanding, `parent-chain-invalid:${document.id}`], 'DOCUMENT_PARENT_CHAIN_INVALID', 'owned document parent chain is not canonical and ledger-valid');
    }
  }
  if (owned.some((document) => document.dirty)) return invalidRecovery(runtime, [...outstanding, ...owned.filter((document) => document.dirty).map((document) => `dirty:${document.id}`)], 'DIRTY_DOCUMENT_UNSAFE', 'an owned child is still dirty');
  for (const document of owned.sort((a, b) => (b.depth ?? 0) - (a.depth ?? 0))) {
    if (signal.aborted) return invalidRecovery(runtime, [...outstanding, 'cancelled'], 'CANCELLED', 'recovery cancelled before cleanup');
    try { await guard('closeDiscard', () => runtime.closeDiscard(document.id)); }
    catch (error) { if (error instanceof RecoveryError && error.category === 'ambiguousState') return invalidRecovery(runtime, [...outstanding, `close-failed:${document.id}`], error.code, error.message, true); return invalidRecovery(runtime, [...outstanding, `close-failed:${document.id}`], 'CLOSE_FAILED', 'owned document cleanup failed'); }
  }
  // Re-inventory after cleanup. A successful close acknowledgement alone does
  // not prove that Photoshop actually removed the document or its children.
  try {
    const remaining = [...await guard('readLayers', runtime.listDocuments)];
    if (remaining.some((document) => document.owned || ledger.has(document.id))) return invalidRecovery(runtime, [...outstanding, 'owned-documents-remain'], 'CLEANUP_POSTCONDITION_FAILED', 'owned documents remain after recovery cleanup');
  } catch (error) { if (error instanceof RecoveryError && error.category === 'ambiguousState') return invalidRecovery(runtime, [...outstanding, 'cleanup-inventory-failed'], error.code, error.message, true); return invalidRecovery(runtime, [...outstanding, 'cleanup-inventory-failed'], 'CLEANUP_INVENTORY_FAILED', 'post-cleanup document inventory failed'); }
  try { if (!(await guard('readDocument', runtime.verifyOriginals))) return invalidRecovery(runtime, [...outstanding, 'original-hash-mismatch'], 'ORIGINAL_HASH_MISMATCH', 'original or dependency hashes changed'); }
  catch (error) { if (error instanceof RecoveryError && error.category === 'ambiguousState') return invalidRecovery(runtime, [...outstanding, 'original-hash-verification-failed'], error.code, error.message, true); return invalidRecovery(runtime, [...outstanding, 'original-hash-verification-failed'], 'ORIGINAL_HASH_FAILED', 'original hash verification failed'); }
  try {
    const finalDocuments = [...await guard('readLayers', runtime.listDocuments)];
    if (finalDocuments.some((document) => document.owned || ledger.has(document.id))) return invalidRecovery(runtime, [...outstanding, 'pending-postcondition-failed'], 'CLEANUP_POSTCONDITION_FAILED', 'pending operations did not clear all owned documents');
  } catch (error) { if (error instanceof RecoveryError && error.category === 'ambiguousState') return invalidRecovery(runtime, [...outstanding, 'pending-postcondition-failed'], error.code, error.message, true); return invalidRecovery(runtime, [...outstanding, 'pending-postcondition-failed'], 'CLEANUP_POSTCONDITION_FAILED', 'pending-operation postcondition could not be proven'); }
  return { safe: true, evidencePaths: recoveryEvidence(runtime), outstanding: [] };
}

export type { OperationKind };
