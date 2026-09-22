import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, normalize } from 'node:path';
import type { DocumentContentType, DocumentState, DocumentTraceRecord, OperationKind } from './types.js';

export type DocumentSnapshot = DocumentState & {
  route: string | null;
  contentType: DocumentContentType;
  selectedLayerId: string | null;
};

export type DocumentOpenResult = { document: DocumentSnapshot; opened: boolean };
export type DocumentOpenRequest = { path: string; contentType: 'psb'; sourceKind?: DocumentSnapshot['sourceKind'] };
export type SaveAcknowledgement = { acknowledged: boolean; parentUpdated: boolean };

export type DocumentAdapter = {
  listDocuments(): Promise<readonly DocumentSnapshot[]>;
  getActiveDocumentId?(): Promise<string | null>;
  getSelectedLayerId?(): Promise<string | null>;
  openDocument(path: string): Promise<DocumentOpenResult>;
  selectLayer?(documentId: string, layerId: string): Promise<void>;
  openContents(documentId: string, layerId: string, request: DocumentOpenRequest): Promise<DocumentOpenResult>;
  saveChild(documentId: string): Promise<SaveAcknowledgement>;
  waitForSaveAcknowledgement?(documentId: string, parentId: string): Promise<SaveAcknowledgement>;
  closeDiscard(documentId: string): Promise<void>;
  activateDocument?(documentId: string): Promise<void>;
  isIdle?(): Promise<boolean>;
};

export type DocumentSessionIdentity = { hostId: string; pid: number; processStartIdentity: string; sessionId: string };
export type DocumentHandle = {
  id: string;
  path: string | null;
  parentId: string | null;
  depth: number;
  owned: boolean;
  sourceKind: DocumentSnapshot['sourceKind'];
  selectedLayerId: string | null;
  lifecycle: 'open' | 'saving' | 'saved' | 'uncertain' | 'closed';
};

export type DocumentTraceSink = { append(record: DocumentTraceRecord): void | Promise<void> };
export type DocumentStackOptions = {
  session: DocumentSessionIdentity;
  workingRoot: string;
  assertWritableTarget?: (path: string) => Promise<{ allowed: true } | { allowed: false; code: string }>;
  evidencePath?: string;
  traceSink?: DocumentTraceSink;
  now?: () => string;
};

export type DocumentStackState = 'open' | 'complete' | 'uncertain' | 'paused' | 'failed';
export type DocumentStackErrorCode =
  | 'DOCUMENT_OPEN_FAILED'
  | 'DOCUMENT_STATE_MISMATCH'
  | 'UNSUPPORTED_CONTENTS'
  | 'CHILD_SAVE_FORBIDDEN'
  | 'CHILD_SAVE_FAILED'
  | 'LINKED_SOURCE_UNISOLATED'
  | 'SAVE_UNCERTAIN'
  | 'FOREIGN_ACTIVE_DOCUMENT'
  | 'CLEANUP_NOT_IDLE'
  | 'ROOT_SOURCE_FORBIDDEN';

export class DocumentStackError extends Error {
  readonly name = 'DocumentStackError';
  constructor(readonly code: DocumentStackErrorCode, message: string, readonly evidence: Readonly<Record<string, unknown>> = {}) {
    super(`${code}: ${message}`);
  }
}

const asErrorCode = (error: unknown): string => {
  if (error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string') return (error as { code: string }).code;
  return '';
};
const pathInRoot = (path: string | null, root: string): boolean => {
  if (!path) return false;
  const target = normalize(path).replaceAll('\\', '/');
  const base = normalize(root).replaceAll('\\', '/').replace(/\/$/, '');
  return target === base || target.startsWith(`${base}/`);
};
const clone = (document: DocumentSnapshot): DocumentSnapshot => ({ ...document });

class Trace {
  private sequence = 0;
  private readonly operationRecords: Array<Extract<OperationKind, 'openDocument' | 'openContents' | 'saveChild' | 'closeDiscard'>> = [];
  constructor(private readonly options: DocumentStackOptions) {}
  operations(): readonly string[] { return [...this.operationRecords]; }
  async record(record: Omit<DocumentTraceRecord, 'sequence' | 'timestamp'>): Promise<void> {
    const complete = { ...record, sequence: ++this.sequence, timestamp: (this.options.now ?? (() => new Date().toISOString()))() } as DocumentTraceRecord;
    if (complete.type === 'operation' && complete.operation) this.operationRecords.push(complete.operation);
    if (this.options.traceSink) await this.options.traceSink.append(complete);
    if (this.options.evidencePath) {
      await mkdir(dirname(this.options.evidencePath), { recursive: true });
      await appendFile(this.options.evidencePath, `${JSON.stringify(complete)}\n`, 'utf8');
    }
  }
}

export class DocumentStack {
  readonly trace: Trace;
  state: DocumentStackState = 'open';
  private readonly ledger = new Map<string, DocumentHandle>();
  private readonly stack: DocumentHandle[] = [];

  constructor(private readonly adapter: DocumentAdapter, private readonly options: DocumentStackOptions) {
    if (!options.session.hostId || !options.session.processStartIdentity || !options.session.sessionId) throw new TypeError('session identity is required');
    this.trace = new Trace(options);
  }

  private ownershipKey(id: string): string { return `${this.options.session.hostId}:${this.options.session.pid}:${this.options.session.processStartIdentity}:${this.options.session.sessionId}:${id}`; }
  private async snapshot(): Promise<readonly DocumentSnapshot[]> { return (await this.adapter.listDocuments()).map(clone); }
  private async activeId(): Promise<string | null> {
    if (this.adapter.getActiveDocumentId) return this.adapter.getActiveDocumentId();
    return (await this.snapshot()).find((document) => document.selectedLayerId !== null)?.id ?? null;
  }
  private async selectedLayerId(): Promise<string | null> { return this.adapter.getSelectedLayerId ? this.adapter.getSelectedLayerId() : null; }
  private register(handle: DocumentHandle): void {
    this.stack.push(handle);
    if (handle.owned) this.ledger.set(this.ownershipKey(handle.id), handle);
  }
  private async assertActive(handle: DocumentHandle, layerId?: string): Promise<void> {
    const active = await this.activeId();
    if (active !== handle.id) {
      this.state = 'paused';
      throw new DocumentStackError('FOREIGN_ACTIVE_DOCUMENT', 'active document changed outside the owned route', { expected: handle.id, actual: active });
    }
    if (layerId !== undefined) {
      const selected = await this.selectedLayerId();
      if (selected !== layerId) {
        if (!this.adapter.selectLayer) throw new DocumentStackError('DOCUMENT_STATE_MISMATCH', 'selected layer cannot be asserted', { documentId: handle.id, expectedLayerId: layerId, actualLayerId: selected });
        await this.adapter.selectLayer(handle.id, layerId);
        const confirmed = await this.selectedLayerId();
        if (confirmed !== layerId) throw new DocumentStackError('DOCUMENT_STATE_MISMATCH', 'selected layer acknowledgement is not current', { documentId: handle.id, expectedLayerId: layerId, actualLayerId: confirmed });
      }
    }
  }
  private async authorize(handle: DocumentHandle): Promise<'allowed' | 'denied'> {
    if (!handle.path || !pathInRoot(handle.path, this.options.workingRoot)) return 'denied';
    if (!this.options.assertWritableTarget) return 'denied';
    return (await this.options.assertWritableTarget(handle.path)).allowed ? 'allowed' : 'denied';
  }
  private makeHandle(document: DocumentSnapshot, owned: boolean): DocumentHandle {
    return { id: document.id, path: document.path, parentId: document.parentId, depth: this.stack.length, owned, sourceKind: document.sourceKind, selectedLayerId: null, lifecycle: 'open' };
  }
  private async provisionalOpenFailure(before: readonly DocumentSnapshot[], parentId: string | null): Promise<void> {
    const after = await this.snapshot();
    const oldIds = new Set(before.map((document) => document.id));
    const added = after.filter((document) => !oldIds.has(document.id));
    const active = await this.activeId();
    if (added.length !== 1 || active !== added[0]!.id) {
      if (added.length || active !== null) {
        this.state = 'paused';
        await this.trace.record({ type: 'state-transition', transition: 'unknown', reason: 'open failed with ambiguous post-side-effect document state', beforeDocumentIds: before.map((document) => document.id), afterDocumentIds: after.map((document) => document.id), activeDocumentId: active });
      }
      return;
    }
    const provisional = this.makeHandle(added[0]!, true);
    this.register(provisional);
    await this.trace.record({ type: 'ownership-proof', documentId: provisional.id, parentId, route: added[0]!.route, owned: true, provisional: true, ownershipKey: this.ownershipKey(provisional.id), reason: 'unique-new-document-after-open-error' });
    try { await this.close(provisional); }
    catch { this.state = 'paused'; }
  }
  private async openProof(before: readonly DocumentSnapshot[], result: DocumentOpenResult, expectedPath: string, expectedParentId: string | null, expectedRoute: string | null, expectedContentType?: DocumentContentType): Promise<DocumentHandle> {
    const after = await this.snapshot();
    const oldIds = new Set(before.map((document) => document.id));
    const added = after.filter((document) => !oldIds.has(document.id));
    const opened = after.find((document) => document.id === result.document.id);
    const active = await this.activeId();
    const isNew = Boolean(opened && !oldIds.has(opened.id));
    const ownershipAmbiguous = !opened || added.length > 1 || (result.opened !== isNew) || (active !== opened.id);
    if (ownershipAmbiguous) {
      this.state = 'paused';
      await this.trace.record({ type: 'state-transition', transition: 'unknown', reason: 'open ownership is ambiguous', beforeDocumentIds: before.map((document) => document.id), afterDocumentIds: after.map((document) => document.id), activeDocumentId: active });
      throw new DocumentStackError('DOCUMENT_STATE_MISMATCH', 'open ownership cannot be proven without touching foreign state', { expectedPath, expectedParentId, expectedRoute, returned: result.document, added: added.map((document) => document.id), active });
    }
    const actual = opened!;
    const handle = this.makeHandle(actual, isNew);
    this.register(handle);
    await this.trace.record({ type: 'ownership-proof', documentId: handle.id, parentId: handle.parentId, route: actual.route, owned: handle.owned, ...(handle.owned ? { ownershipKey: this.ownershipKey(handle.id) } : {}), reason: handle.owned ? 'new-document-after-open' : 'pre-existing-document-reused', beforeDocumentIds: before.map((document) => document.id), afterDocumentIds: after.map((document) => document.id), activeDocumentId: active, expectedPath, expectedParentId, expectedRoute, provisional: false });
    const invalid = actual.path !== expectedPath || actual.parentId !== expectedParentId || (expectedRoute !== null && actual.route !== expectedRoute) || (expectedContentType !== undefined && actual.contentType !== expectedContentType);
    if (invalid) {
      if (!handle.owned) { this.state = 'paused'; throw new DocumentStackError('DOCUMENT_STATE_MISMATCH', 'pre-existing document does not match the requested route', { expectedPath, expectedParentId, expectedRoute, returned: actual }); }
      const authorization = await this.authorize(handle);
      await this.trace.record({ type: 'state-transition', documentId: handle.id, transition: 'validation-failed', reason: 'open response failed expected request validation', authorization: authorization === 'allowed' ? 'allowed' : 'denied' });
      if (authorization !== 'allowed') { this.state = 'paused'; throw new DocumentStackError('DOCUMENT_STATE_MISMATCH', 'new document validation failed and close target is not authorized', { expectedPath, actualPath: actual.path }); }
      try { await this.close(handle); if (expectedParentId && this.adapter.activateDocument) await this.adapter.activateDocument(expectedParentId); } catch { this.state = 'paused'; }
      throw new DocumentStackError(expectedContentType === 'psb' && actual.contentType !== 'psb' ? 'UNSUPPORTED_CONTENTS' : 'DOCUMENT_STATE_MISMATCH', 'open response does not match the requested route or capability', { expectedPath, expectedParentId, expectedRoute, returned: actual });
    }
    return handle;
  }
  private async operation(operation: Extract<OperationKind, 'openDocument' | 'openContents' | 'saveChild' | 'closeDiscard'>, documentId: string, call: () => Promise<void>): Promise<void> {
    await this.trace.record({ type: 'operation', operation, documentId, state: 'issued' });
    try { await call(); await this.trace.record({ type: 'state-transition', operation, documentId, transition: 'acknowledged' }); }
    catch (error) {
      if (operation !== 'openDocument' && operation !== 'openContents') await this.trace.record({ type: 'state-transition', operation, documentId, transition: asErrorCode(error) === 'SAVE_UNCERTAIN' ? 'unknown' : 'failedSafe', reason: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
  async openRoot(path: string): Promise<DocumentHandle> {
    if (!pathInRoot(path, this.options.workingRoot)) throw new DocumentStackError('ROOT_SOURCE_FORBIDDEN', 'working root must be inside the job-owned directory', { path, workingRoot: this.options.workingRoot });
    const before = await this.snapshot();
    let result: DocumentOpenResult;
    try { result = await (async () => { let output!: DocumentOpenResult; await this.operation('openDocument', path, async () => { output = await this.adapter.openDocument(path); }); return output; })(); }
    catch (error) { await this.provisionalOpenFailure(before, null); if (this.state !== 'paused') await this.trace.record({ type: 'state-transition', operation: 'openDocument', transition: 'failedSafe', reason: error instanceof Error ? error.message : String(error) }); if (error instanceof DocumentStackError) throw error; throw new DocumentStackError('DOCUMENT_OPEN_FAILED', error instanceof Error ? error.message : String(error)); }
    try { return await this.openProof(before, result, path, null, null, 'psd'); }
    catch (error) { if (this.state !== 'paused') this.state = 'failed'; try { await this.cleanup(); } catch { /* preserve the open proof error */ } throw error; }
  }
  async openContents(parent: DocumentHandle, layerId: string, request: DocumentOpenRequest): Promise<DocumentHandle> {
    if (request.contentType !== 'psb') {
      const error = new DocumentStackError('UNSUPPORTED_CONTENTS', 'only PSB child contents are supported', { path: request.path, contentType: request.contentType });
      this.state = 'failed'; try { await this.cleanup(); } catch { /* preserve capability error */ } throw error;
    }
    await this.assertActive(parent, layerId);
    const before = await this.snapshot();
    let result!: DocumentOpenResult;
    try {
      await this.operation('openContents', parent.id, async () => { result = await this.adapter.openContents(parent.id, layerId, request); });
    } catch (error) {
      await this.provisionalOpenFailure(before, parent.id);
      if (this.state !== 'paused') await this.trace.record({ type: 'state-transition', operation: 'openContents', documentId: parent.id, transition: 'failedSafe', reason: error instanceof Error ? error.message : String(error) });
      const normalized = error instanceof DocumentStackError ? error : new DocumentStackError(asErrorCode(error) === 'UNSUPPORTED_CONTENTS' ? 'UNSUPPORTED_CONTENTS' : 'DOCUMENT_OPEN_FAILED', error instanceof Error ? error.message : String(error), { parentId: parent.id, layerId });
      this.state = 'failed'; try { await this.cleanup(); } catch { /* preserve open error */ } throw normalized;
    }
    const expectedRoute = `${parent.id}/${layerId}`;
    try { return await this.openProof(before, result, request.path, parent.id, expectedRoute, 'psb'); }
    catch (error) { if (this.state !== 'paused') this.state = 'failed'; try { await this.cleanup(); } catch { /* preserve the open proof error */ } throw error; }
  }
  private async close(handle: DocumentHandle): Promise<void> {
    if (!handle.owned || handle.lifecycle === 'closed') return;
    if (handle.lifecycle === 'uncertain') throw new DocumentStackError('SAVE_UNCERTAIN', 'uncertain document cannot be closed');
    const authorization = await this.authorize(handle);
    if (authorization !== 'allowed') {
      await this.trace.record({ type: 'state-transition', documentId: handle.id, transition: 'close-denied', reason: 'job-owned target failed canonical writable authorization', authorization: 'denied' });
      throw new DocumentStackError(handle.sourceKind === 'linked' ? 'LINKED_SOURCE_UNISOLATED' : 'ROOT_SOURCE_FORBIDDEN', 'close target is not authorized', { path: handle.path });
    }
    if (!this.adapter.isIdle || !(await this.adapter.isIdle())) throw new DocumentStackError('CLEANUP_NOT_IDLE', 'Photoshop is not proven idle before cleanup');
    await this.assertActive(handle);
    await this.operation('closeDiscard', handle.id, async () => { await this.adapter.closeDiscard(handle.id); });
    handle.lifecycle = 'closed';
    this.ledger.delete(this.ownershipKey(handle.id));
  }
  private async save(handle: DocumentHandle, parent: DocumentHandle): Promise<void> {
    if (!handle.owned || !parent.owned) throw new DocumentStackError('CHILD_SAVE_FORBIDDEN', 'child save requires a job-owned parent and child', { childId: handle.id, parentId: parent.id });
    if (handle.lifecycle === 'closed' || handle.lifecycle === 'saved') return;
    if (handle.lifecycle === 'uncertain' || handle.lifecycle === 'saving') throw new DocumentStackError('SAVE_UNCERTAIN', 'child save state is not safely retryable', { documentId: handle.id });
    if (!pathInRoot(parent.path, this.options.workingRoot) || !pathInRoot(handle.path, this.options.workingRoot)) throw new DocumentStackError('CHILD_SAVE_FORBIDDEN', 'child save target is outside the working copy');
    // Parent authorization is checked after linked-child authorization so a denied B06 target has a precise error.
    if (handle.sourceKind === 'linked') {
      if (!this.options.assertWritableTarget || !handle.path || !(await this.options.assertWritableTarget(handle.path)).allowed) throw new DocumentStackError('LINKED_SOURCE_UNISOLATED', 'linked child target is not authorized by the working-copy closure', { path: handle.path });
    }
    if (await this.authorize(parent) !== 'allowed') throw new DocumentStackError('CHILD_SAVE_FORBIDDEN', 'parent working copy is not authorized', { path: parent.path });
    const current = (await this.snapshot()).find((document) => document.id === handle.id);
    if (!current?.dirty) { handle.lifecycle = 'saved'; return; }
    await this.assertActive(handle);
    handle.lifecycle = 'saving';
    let acknowledgement: SaveAcknowledgement;
    try {
      await this.trace.record({ type: 'operation', operation: 'saveChild', documentId: handle.id, parentId: parent.id, state: 'issued' });
      acknowledgement = await this.adapter.saveChild(handle.id);
      if (this.adapter.waitForSaveAcknowledgement) acknowledgement = await this.adapter.waitForSaveAcknowledgement(handle.id, parent.id);
    } catch (error) {
      const afterFailure = await this.snapshot();
      const failedDocument = afterFailure.find((document) => document.id === handle.id);
      const sideEffect = failedDocument?.dirty === false || (await this.activeId()) !== handle.id;
      const code = asErrorCode(error);
      const detail = error instanceof Error ? error.message : String(error);
      if ((await this.activeId()) !== handle.id) {
        this.state = 'paused';
        await this.trace.record({ type: 'state-transition', operation: 'saveChild', documentId: handle.id, parentId: parent.id, transition: 'unknown', reason: 'foreign document became active during save acknowledgement' });
        throw new DocumentStackError('FOREIGN_ACTIVE_DOCUMENT', 'foreign document became active during save acknowledgement', { expected: handle.id, actual: await this.activeId() });
      }
      const ambiguous = sideEffect || code === 'SAVE_UNCERTAIN' || code === 'SAVE_TIMEOUT' || code === 'TRANSPORT_AMBIGUOUS' || /timeout|ambiguous|acknowledg/i.test(detail);
      await this.trace.record({ type: 'state-transition', operation: 'saveChild', documentId: handle.id, parentId: parent.id, transition: ambiguous ? 'unknown' : 'failedSafe', reason: detail });
      if (ambiguous) {
        handle.lifecycle = 'uncertain';
        this.state = 'uncertain';
        throw new DocumentStackError('SAVE_UNCERTAIN', 'save acknowledgement is ambiguous; no retry or close is permitted', { documentId: handle.id, cause: detail });
      }
      handle.lifecycle = 'open';
      throw new DocumentStackError('CHILD_SAVE_FAILED', detail, { documentId: handle.id });
    }
    await this.assertActive(handle);
    const after = await this.snapshot();
    const saved = after.find((document) => document.id === handle.id);
    if (!acknowledgement.acknowledged || !acknowledgement.parentUpdated || saved?.dirty) {
      handle.lifecycle = 'uncertain'; this.state = 'uncertain';
      await this.trace.record({ type: 'state-transition', operation: 'saveChild', documentId: handle.id, parentId: parent.id, transition: 'unknown', reason: 'save acknowledgement or parent update was not confirmed' });
      throw new DocumentStackError('SAVE_UNCERTAIN', 'save acknowledgement or parent update was not confirmed', { documentId: handle.id });
    }
    handle.lifecycle = 'saved';
    await this.trace.record({ type: 'state-transition', operation: 'saveChild', documentId: handle.id, parentId: parent.id, transition: 'acknowledged' });
  }
  async complete(): Promise<void> {
    if (this.state === 'complete' || this.state === 'failed' || this.state === 'paused') return;
    if (this.state === 'uncertain') throw new DocumentStackError('SAVE_UNCERTAIN', 'document state is already uncertain');
    try {
      for (let index = this.stack.length - 1; index >= 0; index -= 1) {
        const handle = this.stack[index]!;
        if (handle.depth === 0) continue;
        const parent = this.stack[index - 1]!;
        if (!handle.owned) {
          if (parent.owned && this.adapter.activateDocument) await this.adapter.activateDocument(parent.id);
          continue;
        }
        await this.save(handle, parent);
        await this.close(handle);
        if (parent.owned && this.adapter.activateDocument) await this.adapter.activateDocument(parent.id);
      }
      const root = this.stack[0];
      if (root) await this.close(root);
      this.state = 'complete';
      await this.trace.record({ type: 'state-transition', transition: 'complete' });
    } catch (error) {
      if ((this.state as DocumentStackState) === 'uncertain' || (this.state as DocumentStackState) === 'paused') throw error;
      this.state = 'failed';
      try { await this.cleanup(); } catch { /* preserve the original lifecycle error */ }
      throw error;
    }
  }
  async cleanup(): Promise<void> {
    if (this.state === 'uncertain' || this.state === 'paused') return;
    for (let index = this.stack.length - 1; index >= 0; index -= 1) {
      const handle = this.stack[index]!;
      if (!handle.owned) continue;
      await this.close(handle);
      if (index > 0 && this.adapter.activateDocument) await this.adapter.activateDocument(this.stack[index - 1]!.id);
    }
  }
}

export function fileTraceSink(path: string): DocumentTraceSink {
  return { append: async (record) => { await mkdir(dirname(path), { recursive: true }); await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8'); } };
}
