import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
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
export type JournalEntry = {
  sequence: number;
  timestamp: string;
  operation: string;
  requestId: string;
  mutation: boolean;
  state: JournalState;
  reason?: string;
};

export class OperationJournal {
  private readonly entries: JournalEntry[] = [];
  private readonly requests = new Map<string, { operation: string; mutation: boolean }>();
  private sequence = 0;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(readonly filePath?: string) {}

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

  async read(): Promise<JournalEntry[]> {
    if (this.filePath) {
      try {
        const text = await readFile(this.filePath, 'utf8');
        const parsed = text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as JournalEntry);
        this.entries.splice(0, this.entries.length, ...parsed);
        this.sequence = parsed.reduce((max, entry) => Math.max(max, entry.sequence), this.sequence);
        for (const entry of parsed) this.requests.set(entry.requestId, { operation: entry.operation, mutation: entry.mutation });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
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
    const ids = requestId ? [requestId] : this.pendingUnknown();
    for (const id of ids) await this.reconciled(id);
  }

  private async append(input: Omit<JournalEntry, 'sequence' | 'timestamp'>): Promise<JournalEntry> {
    const entry: JournalEntry = { ...input, sequence: ++this.sequence, timestamp: new Date().toISOString() };
    this.entries.push(entry);
    this.writeQueue = this.writeQueue.then(async () => {
      if (!this.filePath) return;
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8');
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  let rejectRace!: (error: unknown) => void;
  const raceSignal = new Promise<never>((_, reject) => { rejectRace = reject; });
  const callPromise = Promise.resolve().then(() => {
    dispatched = true;
    return options.call();
  });
  callPromise.catch(() => undefined);
  const timeoutMs = options.timeoutMs ?? operationTimeoutMs(options.operation);
  timer = setTimeout(() => rejectRace(new RecoveryError('OPERATION_TIMEOUT', `${options.operation} exceeded its ${timeoutMs}ms failure-detection ceiling`, 'ambiguousState', false)), timeoutMs);
  if (options.signal) {
    abortListener = () => rejectRace(cancellation(options.signal!, dispatched));
    options.signal.addEventListener('abort', abortListener, { once: true });
  }

  try {
    const result = await Promise.race([callPromise, raceSignal]);
    await options.journal.acknowledged(options.requestId);
    return result as T;
  } catch (error) {
    const ambiguous = dispatched && (error instanceof RecoveryError ? error.category === 'ambiguousState' : true);
    if (ambiguous) {
      const reason = error instanceof Error ? error.message : String(error);
      await options.journal.unknown(options.requestId, reason);
      await options.onUnknown?.();
      if (error instanceof RecoveryError && error.category === 'ambiguousState') throw error;
      throw new RecoveryError('TRANSPORT_AMBIGUOUS', `${options.operation} acknowledgement is unknown`, 'ambiguousState', false);
    }
    await options.journal.failedSafe(options.requestId, error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (options.signal && abortListener) options.signal.removeEventListener('abort', abortListener);
  }
}

export type RecoveryDocument = { id: string; path: string | null; owned: boolean; dirty: boolean; parentId: string | null; depth?: number };
export type RecoveryRuntime = {
  journal: { read: () => Promise<JournalEntry[]> };
  listDocuments: () => Promise<readonly RecoveryDocument[]>;
  isIdle: () => Promise<boolean>;
  safeCompletion?: () => Promise<boolean>;
  verifyOriginals: () => Promise<boolean>;
  closeDiscard: (documentId: string) => Promise<void>;
  evidencePaths?: readonly string[];
};

export type RecoveryResult = { safe: boolean; evidencePaths: string[]; outstanding: string[] };

/** Reconciles state only; it never replays the journal's mutation records. */
export async function recoverJob(_jobId: string, runtime: RecoveryRuntime, signal: AbortSignal): Promise<RecoveryResult> {
  if (signal.aborted) throw cancellation(signal, false);
  let entries: JournalEntry[];
  try { entries = await runtime.journal.read(); } catch { return { safe: false, evidencePaths: [...(runtime.evidencePaths ?? [])], outstanding: ['journal-read-failed'] }; }
  const outstanding = new Set<string>();
  for (const entry of entries) {
    if (entry.state === 'issued' || entry.state === 'unknown') outstanding.add(entry.requestId);
    if (entry.state === 'acknowledged' || entry.state === 'failedSafe' || entry.state === 'reconciled') outstanding.delete(entry.requestId);
  }
  try {
    if (!(await runtime.isIdle())) return { safe: false, evidencePaths: [...(runtime.evidencePaths ?? [])], outstanding: [...outstanding] };
    if (outstanding.size > 0 && (!runtime.safeCompletion || !(await runtime.safeCompletion()))) return { safe: false, evidencePaths: [...(runtime.evidencePaths ?? [])], outstanding: [...outstanding] };
  } catch { return { safe: false, evidencePaths: [...(runtime.evidencePaths ?? [])], outstanding: [...outstanding, 'idle-proof-failed'] }; }
  let documents: RecoveryDocument[];
  try { documents = [...await runtime.listDocuments()]; } catch { return { safe: false, evidencePaths: [...(runtime.evidencePaths ?? [])], outstanding: [...outstanding, 'document-inventory-failed'] }; }
  const owned = documents.filter((document) => document.owned);
  if (owned.some((document) => document.dirty)) return { safe: false, evidencePaths: [...(runtime.evidencePaths ?? [])], outstanding: [...outstanding, ...owned.filter((document) => document.dirty).map((document) => `dirty:${document.id}`)] };
  for (const document of owned.sort((a, b) => (b.depth ?? 0) - (a.depth ?? 0))) {
    if (signal.aborted) throw cancellation(signal, false);
    try { await runtime.closeDiscard(document.id); }
    catch { return { safe: false, evidencePaths: [...(runtime.evidencePaths ?? [])], outstanding: [...outstanding, `close-failed:${document.id}`] }; }
  }
  try { if (!(await runtime.verifyOriginals())) return { safe: false, evidencePaths: [...(runtime.evidencePaths ?? [])], outstanding: [...outstanding, 'original-hash-mismatch'] }; }
  catch { return { safe: false, evidencePaths: [...(runtime.evidencePaths ?? [])], outstanding: [...outstanding, 'original-hash-verification-failed'] }; }
  return { safe: true, evidencePaths: [...(runtime.evidencePaths ?? [])], outstanding: [] };
}

export type { OperationKind };
