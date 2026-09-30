import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateCanonicalTrace } from '../../packages/photoshop/src/backend.js';
import { CanonicalTraceWriter } from '../../packages/photoshop/src/trace.js';
import { describe, expect, it } from 'vitest';
import {
  DocumentStack,
  DocumentStackError,
  type DocumentAdapter,
  type DocumentStackOptions,
  type DocumentSnapshot,
} from '../../packages/photoshop/src/documents.js';

const ROOT = '/job/working/template.psd';
const CHILD = '/job/working/child.psb';
const NESTED = '/job/working/nested.psb';
const USER = '/user/notes.psd';

function doc(id: string, path: string, parentId: string | null, dirty = false, sourceKind: DocumentSnapshot['sourceKind'] = 'root'): DocumentSnapshot {
  return { id, path, parentId, route: parentId ? `${parentId}/contents` : null, dirty, sourceKind, contentType: 'psb', selectedLayerId: null };
}

class FakeDocuments implements DocumentAdapter {
  readonly operations: string[] = [];
  readonly saves: string[] = [];
  readonly closes: string[] = [];
  readonly docs = new Map<string, DocumentSnapshot>([
    ['user', { ...doc('user', USER, null, true), contentType: 'psd' }],
  ]);
  activeDocumentId: string | null = 'user';
  selectedLayerId: string | null = null;
  failOpen = false;
  failChildOpen = false;
  saveFailure = false;
  failOpenAfterMutation = false;
  wrongRootPath = false;
  wrongChildRoute = false;
  returnedChildType: DocumentSnapshot['contentType'] = 'psb';
  extraDocumentAfterOpen = false;
  foreignAfterOpen = false;
  falseAcknowledgement = false;
  falseWaitAcknowledgement = false;
  foreignDuringSave = false;
  foreignDuringWait = false;
  unsupported = false;
  ambiguousSave = false;
  foreignOnClose = false;
  childPath = CHILD;
  nestedPath = NESTED;

  async listDocuments(): Promise<readonly DocumentSnapshot[]> { return [...this.docs.values()].map((entry) => ({ ...entry })); }
  async getActiveDocumentId(): Promise<string | null> { return this.activeDocumentId; }
  async getSelectedLayerId(): Promise<string | null> { return this.selectedLayerId; }
  async openDocument(path: string): Promise<{ document: DocumentSnapshot; opened: boolean }> {
    this.operations.push('openDocument');
    if (this.failOpen) throw new DocumentStackError('DOCUMENT_OPEN_FAILED', 'open root failed');
    const existing = [...this.docs.values()].find((entry) => entry.path === path);
    if (existing) { this.activeDocumentId = existing.id; return { document: existing, opened: false }; }
    const opened = { ...doc('root-job', path, null, true), contentType: 'psd' as const, ...(this.wrongRootPath ? { path: '/job/working/wrong.psd' } : {}) };
    this.docs.set(opened.id, opened);
    if (this.extraDocumentAfterOpen) this.docs.set('unexpected', doc('unexpected', '/job/working/unexpected.psd', null, false));
    this.activeDocumentId = this.foreignAfterOpen ? 'user' : opened.id;
    if (this.failOpenAfterMutation) throw new Error('open reply lost after mutation');
    return { document: opened, opened: true };
  }
  async selectLayer(documentId: string, layerId: string): Promise<void> {
    if (this.activeDocumentId !== documentId) throw new Error('wrong active document');
    this.selectedLayerId = layerId;
  }
  async activateDocument(documentId: string): Promise<void> { this.activeDocumentId = documentId; this.selectedLayerId = null; }
  async openContents(documentId: string, layerId: string, request: { path: string; contentType?: string; sourceKind?: DocumentSnapshot['sourceKind'] }): Promise<{ document: DocumentSnapshot; opened: boolean }> {
    this.operations.push('openContents');
    if (this.failOpen || this.failChildOpen) throw new DocumentStackError('DOCUMENT_OPEN_FAILED', 'open child failed');
    if (this.unsupported || request.contentType !== 'psb') throw new DocumentStackError('UNSUPPORTED_CONTENTS', 'contents are not PSB');
    const existing = [...this.docs.values()].find((entry) => entry.path === request.path);
    if (existing) { this.activeDocumentId = existing.id; return { document: existing, opened: false }; }
    const id = request.path === CHILD ? 'child-job' : 'nested-job';
    const opened = { ...doc(id, request.path, documentId, true, request.sourceKind ?? 'embedded'), contentType: this.returnedChildType };
    opened.route = this.wrongChildRoute ? `${documentId}/wrong-layer` : `${documentId}/${layerId}`;
    this.docs.set(id, opened);
    if (this.extraDocumentAfterOpen) this.docs.set('unexpected-child', doc('unexpected-child', '/job/working/unexpected.psb', documentId, false, 'embedded'));
    this.activeDocumentId = this.foreignAfterOpen ? 'user' : id;
    if (this.failOpenAfterMutation) throw new Error('open reply lost after mutation');
    return { document: opened, opened: true };
  }
  async saveChild(documentId: string): Promise<{ acknowledged: boolean; parentUpdated: boolean }> {
    this.operations.push('saveChild'); this.saves.push(documentId);
    if (this.saveFailure) throw new Error('disk save failed');
    if (this.foreignDuringSave) this.activeDocumentId = 'user';
    if (this.falseAcknowledgement) return { acknowledged: false, parentUpdated: false };
    if (this.ambiguousSave) throw new DocumentStackError('SAVE_UNCERTAIN', 'save acknowledgement timed out');
    const current = this.docs.get(documentId)!; current.dirty = false;
    if (current.parentId) this.docs.get(current.parentId)!.dirty = true;
    return { acknowledged: true, parentUpdated: true };
  }
  async waitForSaveAcknowledgement(documentId: string, parentId: string): Promise<{ acknowledged: boolean; parentUpdated: boolean }> {
    if (this.foreignDuringWait) this.activeDocumentId = 'user';
    if (this.falseWaitAcknowledgement || this.falseAcknowledgement) return { acknowledged: false, parentUpdated: false };
    return { acknowledged: true, parentUpdated: true };
  }
  async closeDiscard(documentId: string): Promise<void> {
    this.operations.push('closeDiscard'); this.closes.push(documentId);
    if (this.foreignOnClose) throw new DocumentStackError('FOREIGN_ACTIVE_DOCUMENT', 'foreign document active');
    if (this.activeDocumentId !== documentId) throw new DocumentStackError('FOREIGN_ACTIVE_DOCUMENT', 'wrong active document');
    this.docs.delete(documentId); this.activeDocumentId = null; this.selectedLayerId = null;
  }
  async isIdle(): Promise<boolean> { return true; }
}

const stack = (adapter: FakeDocuments, evidencePath?: string, overrides: Partial<DocumentStackOptions> = {}) => new DocumentStack(adapter, {
  session: { hostId: 'test-host', pid: 10, processStartIdentity: 'start', sessionId: 'session' },
  workingRoot: '/job/working',
  evidencePath,
  assertWritableTarget: async () => ({ allowed: true }),
  ...overrides,
});

describe('owned Photoshop document stack', () => {
  it('persists actual document bytes before and after the owned lifecycle', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'b15-document-trace-'));
    const source = join(dir, 'template.psd');
    const tracePath = join(dir, 'document-trace.jsonl');
    await writeFile(source, 'original-working-copy');
    const adapter = new FakeDocuments();
    const originalClose = adapter.closeDiscard.bind(adapter);
    adapter.closeDiscard = async (id) => { await writeFile(source, 'saved-working-copy'); await originalClose(id); };
    const trace = stack(adapter, undefined, { workingRoot: dir, canonicalTrace: new CanonicalTraceWriter(dir, tracePath, { operationId: 'job:asset:1', requestId: 'document-lifecycle' }) });
    await trace.openRoot(source);
    await trace.complete();
    await expect(validateCanonicalTrace(dir, 'document-trace.jsonl', 'job:asset:1')).resolves.toBeUndefined();
    const records = (await readFile(tracePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { phase: string; path?: string; detail?: { type: string; transition?: string; owned?: boolean } });
    expect(await readFile(join(dir, records[0]!.path!), 'utf8')).toBe('original-working-copy');
    expect(await readFile(join(dir, records.at(-1)!.path!), 'utf8')).toBe('saved-working-copy');
    expect(records.some((record) => record.detail?.type === 'ownership-proof' && record.detail.owned === true)).toBe(true);
    expect(records.some((record) => record.detail?.transition === 'complete')).toBe(true);
  });
  it('saves deepest children inward and discards only owned documents', async () => {
    const adapter = new FakeDocuments(); const trace = stack(adapter);
    const root = await trace.openRoot(ROOT);
    const child = await trace.openContents(root, 'child-layer', { path: CHILD, contentType: 'psb' });
    await trace.openContents(child, 'nested-layer', { path: NESTED, contentType: 'psb' });
    await trace.complete();
    expect(adapter.operations).toEqual(['openDocument', 'openContents', 'openContents', 'saveChild', 'closeDiscard', 'saveChild', 'closeDiscard', 'closeDiscard']);
    expect(adapter.saves).toEqual(['nested-job', 'child-job']);
    expect(adapter.docs.get('user')?.dirty).toBe(true);
    expect(adapter.docs.has('user')).toBe(true);
  });

  it('does not own, save, or close a pre-opened child', async () => {
    const adapter = new FakeDocuments();
    adapter.docs.set('preexisting-child', { ...doc('preexisting-child', CHILD, 'root-job', true, 'embedded'), route: 'root-job/child-layer' });
    const trace = stack(adapter); const root = await trace.openRoot(ROOT);
    const child = await trace.openContents(root, 'child-layer', { path: CHILD, contentType: 'psb' });
    await trace.complete();
    expect(child.id).toBe('preexisting-child'); expect(adapter.saves).toEqual([]); expect(adapter.closes).toEqual(['root-job']);
    expect(adapter.docs.get('preexisting-child')?.dirty).toBe(true); expect(adapter.docs.has('preexisting-child')).toBe(true);
  });

  it('reports failed child opens and cleans the owned root', async () => {
    const adapter = new FakeDocuments(); adapter.failChildOpen = true; const trace = stack(adapter);
    const root = await trace.openRoot(ROOT);
    await expect(trace.openContents(root, 'layer', { path: CHILD, contentType: 'psb' })).rejects.toMatchObject({ code: 'DOCUMENT_OPEN_FAILED' });
    expect(adapter.closes).toEqual(['root-job']);
  });

  it('refuses unsupported contents with a stable capability error', async () => {
    const adapter = new FakeDocuments(); const trace = stack(adapter); const root = await trace.openRoot(ROOT);
    await expect(trace.openContents(root, 'layer', { path: CHILD, contentType: 'psd' })).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENTS' });
  });

  it('does not retry or close after an ambiguous save', async () => {
    const adapter = new FakeDocuments(); adapter.ambiguousSave = true; const trace = stack(adapter);
    const root = await trace.openRoot(ROOT); const child = await trace.openContents(root, 'layer', { path: CHILD, contentType: 'psb' });
    await expect(trace.complete()).rejects.toMatchObject({ code: 'SAVE_UNCERTAIN' });
    expect(adapter.saves).toEqual(['child-job']); expect(adapter.closes).toEqual([]); expect(trace.state).toBe('uncertain');
  });

  it('classifies a confirmed child save failure and cleans owned copies', async () => {
    const adapter = new FakeDocuments(); adapter.saveFailure = true; const trace = stack(adapter);
    const root = await trace.openRoot(ROOT); await trace.openContents(root, 'layer', { path: CHILD, contentType: 'psb' });
    await expect(trace.complete()).rejects.toMatchObject({ code: 'CHILD_SAVE_FAILED' });
    const operations = [...adapter.operations]; await trace.complete();
    expect(adapter.saves).toEqual(['child-job']); expect(adapter.closes).toEqual(['child-job', 'root-job']); expect(adapter.operations).toEqual(operations);
  });

  it('requires B06 authorization before saving linked children', async () => {
    const adapter = new FakeDocuments(); const trace = new DocumentStack(adapter, {
      session: { hostId: 'test-host', pid: 10, processStartIdentity: 'start', sessionId: 'session' }, workingRoot: '/job/working',
      assertWritableTarget: async () => ({ allowed: false, code: 'LINKED_SOURCE_UNISOLATED' }),
    });
    const root = await trace.openRoot(ROOT); await trace.openContents(root, 'layer', { path: CHILD, contentType: 'psb', sourceKind: 'linked' });
    await expect(trace.complete()).rejects.toMatchObject({ code: 'LINKED_SOURCE_UNISOLATED' });
    expect(adapter.saves).toEqual([]); expect(adapter.closes).toEqual([]);
  });

  it('fails closed when a foreign document becomes active', async () => {
    const adapter = new FakeDocuments(); const trace = stack(adapter); await trace.openRoot(ROOT);
    adapter.activeDocumentId = 'user';
    await expect(trace.complete()).rejects.toMatchObject({ code: 'FOREIGN_ACTIVE_DOCUMENT' });
    expect(adapter.docs.has('user')).toBe(true); expect(adapter.docs.get('user')?.dirty).toBe(true); expect(adapter.closes).toEqual([]);
  });

  it('writes append-only lifecycle evidence through the injected path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ne-psd-b07-')); const evidencePath = join(dir, 'document-trace.jsonl');
    const adapter = new FakeDocuments(); const trace = stack(adapter, evidencePath); const root = await trace.openRoot(ROOT);
    await trace.openContents(root, 'layer', { path: CHILD, contentType: 'psb' }); await trace.complete();
    const lines = (await readFile(evidencePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.some((line) => line.type === 'ownership-proof')).toBe(true); expect(lines.some((line) => line.type === 'state-transition')).toBe(true);
    expect(lines.filter((line) => line.type === 'operation').map((line) => line.operation)).toEqual(['openDocument', 'openContents', 'saveChild', 'closeDiscard', 'closeDiscard']);
  });

  it('provisionally owns and closes a unique root when response validation fails', async () => {
    const adapter = new FakeDocuments(); adapter.wrongRootPath = true; const trace = stack(adapter);
    await expect(trace.openRoot(ROOT)).rejects.toMatchObject({ code: 'DOCUMENT_STATE_MISMATCH' });
    expect(adapter.closes).toEqual(['root-job']);
  });

  it('closes a uniquely opened unsupported child, then the owned parent', async () => {
    const adapter = new FakeDocuments(); adapter.returnedChildType = 'psd'; const trace = stack(adapter);
    const root = await trace.openRoot(ROOT);
    await expect(trace.openContents(root, 'layer', { path: CHILD, contentType: 'psb' })).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENTS' });
    expect(adapter.closes).toEqual(['child-job', 'root-job']);
  });

  it('pauses without closing when an open adds multiple or activates foreign state', async () => {
    const multiple = new FakeDocuments(); multiple.extraDocumentAfterOpen = true; const first = stack(multiple);
    await expect(first.openRoot(ROOT)).rejects.toMatchObject({ code: 'DOCUMENT_STATE_MISMATCH' });
    expect(multiple.closes).toEqual([]); expect(first.state).toBe('paused');
    const foreign = new FakeDocuments(); foreign.foreignAfterOpen = true; const second = stack(foreign);
    await expect(second.openRoot(ROOT)).rejects.toMatchObject({ code: 'DOCUMENT_STATE_MISMATCH' });
    expect(foreign.closes).toEqual([]); expect(foreign.docs.has('user')).toBe(true);
  });

  it('makes cleanup and complete idempotent after successful close', async () => {
    const adapter = new FakeDocuments(); const trace = stack(adapter); const root = await trace.openRoot(ROOT);
    await trace.openContents(root, 'layer', { path: CHILD, contentType: 'psb' }); await trace.complete();
    const operations = [...adapter.operations]; await trace.cleanup(); await trace.complete();
    expect(adapter.operations).toEqual(operations); expect(adapter.saves).toEqual(['child-job']); expect(adapter.closes).toEqual(['child-job', 'root-job']);
  });

  it('records unknown evidence for false acknowledgements without closing', async () => {
    const adapter = new FakeDocuments(); adapter.falseAcknowledgement = true; const records: Array<Record<string, unknown>> = [];
    const trace = stack(adapter, undefined, { traceSink: { append: (record) => { records.push(record as unknown as Record<string, unknown>); } } });
    const root = await trace.openRoot(ROOT); await trace.openContents(root, 'layer', { path: CHILD, contentType: 'psb' });
    await expect(trace.complete()).rejects.toMatchObject({ code: 'SAVE_UNCERTAIN' });
    expect(records.some((record) => record.transition === 'unknown' && record.operation === 'saveChild')).toBe(true);
    expect(adapter.saves).toEqual(['child-job']); expect(adapter.closes).toEqual([]);
  });

  it('treats a false wait acknowledgement as uncertain without retry', async () => {
    const adapter = new FakeDocuments(); adapter.falseWaitAcknowledgement = true; const trace = stack(adapter);
    const root = await trace.openRoot(ROOT); await trace.openContents(root, 'layer', { path: CHILD, contentType: 'psb' });
    await expect(trace.complete()).rejects.toMatchObject({ code: 'SAVE_UNCERTAIN' });
    expect(adapter.saves).toEqual(['child-job']); expect(adapter.closes).toEqual([]); expect(trace.state).toBe('uncertain');
  });

  it('pauses on a foreign activation during save acknowledgement', async () => {
    const adapter = new FakeDocuments(); adapter.foreignDuringWait = true; const trace = stack(adapter);
    const root = await trace.openRoot(ROOT); await trace.openContents(root, 'layer', { path: CHILD, contentType: 'psb' });
    await expect(trace.complete()).rejects.toMatchObject({ code: 'FOREIGN_ACTIVE_DOCUMENT' });
    expect(trace.state).toBe('paused'); expect(adapter.saves).toEqual(['child-job']); expect(adapter.closes).toEqual([]); expect(adapter.docs.get('user')?.dirty).toBe(true);
  });

  it('does not clean a reused dirty child after a failed owned lifecycle', async () => {
    const adapter = new FakeDocuments(); adapter.docs.set('preexisting-child', { ...doc('preexisting-child', CHILD, 'root-job', true, 'embedded'), route: 'root-job/layer' });
    const trace = stack(adapter); const root = await trace.openRoot(ROOT); await trace.openContents(root, 'layer', { path: CHILD, contentType: 'psb' });
    await trace.complete();
    expect(adapter.saves).toEqual([]); expect(adapter.closes).toEqual(['root-job']); expect(adapter.docs.get('preexisting-child')?.dirty).toBe(true); expect(adapter.docs.has('preexisting-child')).toBe(true);
  });
});
