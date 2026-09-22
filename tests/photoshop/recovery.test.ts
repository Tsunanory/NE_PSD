import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  OperationJournal,
  operationTimeoutMs,
  runUncertainOperation,
  recoverJob,
  type RecoveryDocument,
  type RecoveryRuntime,
} from '../../packages/photoshop/src/recovery.js';
import { McpClient, type ToolTransport } from '../../packages/photoshop/src/mcp-client.js';
import { buildToolMap } from '../../packages/photoshop/src/tool-map.js';
import { SessionLock } from '../../packages/photoshop/src/session-lock.js';
import { PhotoshopBackend, type BackendAdapter } from '../../packages/photoshop/src/backend.js';

const fixtureTools = [{
  name: 'fixture_scale',
  inputSchema: { type: 'object', properties: { percent: { type: 'number' } }, required: ['percent'], additionalProperties: false },
  outputSchema: { type: 'object', properties: { acknowledged: { const: true } }, required: ['acknowledged'], additionalProperties: false },
}];

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

describe('conservative Photoshop recovery', () => {
  it('uses fixed operation ceilings and keeps the journal append-only', async () => {
    expect(operationTimeoutMs('readLayers')).toBe(15_000);
    expect(operationTimeoutMs('openDocument')).toBe(120_000);
    expect(operationTimeoutMs('place')).toBe(120_000);
    expect(operationTimeoutMs('scale')).toBe(120_000);
    expect(operationTimeoutMs('closeDiscard')).toBe(120_000);
    expect(operationTimeoutMs('saveChild')).toBe(180_000);
    expect(operationTimeoutMs('export')).toBe(180_000);

    const root = await mkdtemp(join(tmpdir(), 'ne-psd-recovery-'));
    const journal = new OperationJournal(join(root, 'journal.jsonl'));
    await journal.issued({ operation: 'place', requestId: 'r1', mutation: true });
    await journal.acknowledged('r1');
    await journal.issued({ operation: 'scale', requestId: 'r2', mutation: true });
    await journal.unknown('r2', 'timeout');
    const lines = (await readFile(join(root, 'journal.jsonl'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(4);
    expect(journal.pendingUnknown()).toEqual(['r2']);
    await rm(root, { recursive: true, force: true });
  });

  it('never replays a mutation after a dispatched timeout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ne-psd-recovery-'));
    const journal = new OperationJournal(join(root, 'journal.jsonl'));
    let calls = 0;
    const controller = new AbortController();
    const promise = runUncertainOperation({
      operation: 'scale',
      requestId: 'scale-1',
      mutation: true,
      timeoutMs: 10,
      journal,
      signal: controller.signal,
      call: async () => { calls += 1; await delay(40); return { acknowledged: true }; },
    });
    await expect(promise).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT', category: 'ambiguousState', retryable: false });
    expect(calls).toBe(1);
    await delay(50);
    expect(journal.pendingUnknown()).toEqual(['scale-1']);
    await rm(root, { recursive: true, force: true });
  });

  it('refuses reconciliation while the late transport promise is unresolved', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ne-psd-recovery-'));
    const journal = new OperationJournal(join(root, 'journal.jsonl'));
    let settle!: () => void;
    const pending = runUncertainOperation({ operation: 'scale', requestId: 'late-1', mutation: true, timeoutMs: 5, journal, call: async () => new Promise((resolve) => { settle = () => resolve({ acknowledged: true }); }) });
    await expect(pending).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
    await expect(journal.reconcile()).rejects.toMatchObject({ code: 'UNSETTLED_OPERATION', category: 'ambiguousState' });
    settle();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await journal.reconcile();
    expect(journal.pendingUnknown()).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });

  it('fails closed when an unknown terminal journal append fails', async () => {
    class FailingJournal extends OperationJournal {
      override async unknown(): Promise<never> { throw new Error('disk full'); }
    }
    let marked = false;
    await expect(runUncertainOperation({ operation: 'place', requestId: 'journal-fail', mutation: true, timeoutMs: 5, journal: new FailingJournal(), onUnknown: () => { marked = true; }, call: async () => new Promise(() => undefined) })).rejects.toMatchObject({ category: 'ambiguousState', retryable: false });
    expect(marked).toBe(true);
  });

  it('rejects corrupted, out-of-order, and identity-mismatched journal entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ne-psd-recovery-'));
    const path = join(root, 'journal.jsonl');
    const journal = new OperationJournal(path, { jobId: 'job-a', operationId: 'op-a', hostId: 'host-a', ownershipToken: 'token-a', installationDigest: 'a'.repeat(64) });
    await journal.issued({ operation: 'place', requestId: 'r1', mutation: true });
    const first = (await readFile(path, 'utf8')).trim();
    await writeFile(path, `${first.replace('"sequence":1', '"sequence":2')}\n`);
    await expect(journal.read()).rejects.toMatchObject({ code: 'JOURNAL_CORRUPT' });
    await rm(root, { recursive: true, force: true });
  });

  it.each(['place', 'scale', 'saveChild', 'export', 'closeDiscard'] as const)('retains the barrier after a lost %s acknowledgement', async (operation) => {
    const root = await mkdtemp(join(tmpdir(), 'ne-psd-recovery-'));
    const journal = new OperationJournal(join(root, 'journal.jsonl'));
    let calls = 0;
    await expect(runUncertainOperation({
      operation,
      requestId: `${operation}-lost`,
      mutation: true,
      timeoutMs: 5,
      journal,
      call: async () => { calls += 1; await delay(25); return { acknowledged: true }; },
    })).rejects.toMatchObject({ category: 'ambiguousState', retryable: false });
    expect(calls).toBe(1);
    await delay(30);
    expect(journal.pendingUnknown()).toEqual([`${operation}-lost`]);
    await rm(root, { recursive: true, force: true });
  });

  it('treats an abort after dispatch as ambiguous and never issues a second call', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ne-psd-recovery-'));
    const journal = new OperationJournal(join(root, 'journal.jsonl'));
    const controller = new AbortController();
    let calls = 0;
    const pending = runUncertainOperation({ operation: 'place', requestId: 'place-abort', mutation: true, timeoutMs: 500, journal, signal: controller.signal, call: async () => { calls += 1; await delay(100); return { acknowledged: true }; } });
    await delay(50);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED_AFTER_DISPATCH', category: 'ambiguousState' });
    expect(calls).toBe(1);
    await rm(root, { recursive: true, force: true });
  });

  it('cancels before dispatch without journaling a mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ne-psd-recovery-'));
    const journal = new OperationJournal(join(root, 'journal.jsonl'));
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await expect(runUncertainOperation({ operation: 'export', requestId: 'export-1', mutation: true, journal, signal: controller.signal, call: async () => { calls += 1; return {}; } })).rejects.toMatchObject({ code: 'CANCELLED', category: 'cancelled' });
    expect(calls).toBe(0);
    expect(journal.pendingUnknown()).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });

  it('holds the client barrier through a late response and rejects competing calls', async () => {
    let calls = 0;
    let finish!: () => void;
    const delayed = new Promise<unknown>((resolve) => { finish = () => resolve({ acknowledged: true }); });
    const transport: ToolTransport = {
      async listTools() { return { tools: fixtureTools }; },
      async callTool() { calls += 1; return delayed; },
    };
    const client = new McpClient({ transport, toolMap: buildToolMap(fixtureTools), timeouts: { scale: 10 } });
    await expect(client.callRaw('fixture_scale', { percent: 100 })).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT', category: 'ambiguousState', retryable: false });
    expect(calls).toBe(1);
    await expect(client.callRaw('fixture_scale', { percent: 100 })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    await expect(client.reconcile()).rejects.toMatchObject({ code: 'UNSETTLED_OPERATION' });
    finish();
    await delay(0);
    await client.reconcile();
    await expect(client.callRaw('fixture_scale', { percent: 100 })).resolves.toMatchObject({ acknowledged: true });
    expect(calls).toBe(2);
  });

  it('retains the OS-visible lock after an uncertain transaction until explicit reconciliation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ne-psd-recovery-'));
    const lock = new SessionLock({
      lockPath: join(root, 'photoshop.lock'),
      installationPath: '/Applications/Adobe Photoshop.app',
      hostId: 'host-a',
      installationDigest: 'a'.repeat(64),
      pid: 101,
      processStartIdentity: 'start-a',
      randomToken: () => 'token-a',
    });
    let release!: () => void;
    const transport: ToolTransport = {
      async listTools() { return { tools: fixtureTools }; },
      async callTool() { return new Promise((resolve) => { release = () => resolve({ acknowledged: true }); }); },
    };
    const client = new McpClient({ transport, toolMap: buildToolMap(fixtureTools), sessionLock: lock, timeouts: { scale: 5 } });
    await expect(lock.runExclusive('job-a', () => client.callRaw('fixture_scale', { percent: 100 }))).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
    const lockMetadata = JSON.parse(await readFile(join(root, 'photoshop.lock', 'owner.json'), 'utf8')) as { journalPath: string };
    expect(lockMetadata.journalPath).toContain('job-a');
    expect((await readFile(lockMetadata.journalPath, 'utf8')).length).toBeGreaterThan(0);
    expect(await lock.tryAcquire({ jobId: 'job-b' })).toEqual({ acquired: false, reason: 'RECOVERY_REQUIRED' });
    release();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await client.reconcile();
    expect(await lock.tryAcquire({ jobId: 'job-b' })).toMatchObject({ acquired: true });
    await lock.release();
    await rm(root, { recursive: true, force: true });
  });

  it('does not claim safe recovery while a job-owned child is dirty or a foreign document exists', async () => {
    const documents: RecoveryDocument[] = [{ id: 'child', path: '/job/child.psb', owned: true, dirty: true, parentId: 'root' }];
    const runtime: RecoveryRuntime = {
      journal: { read: async () => [{ operation: 'saveChild', requestId: 'save-1', mutation: true, state: 'unknown' }] },
      listDocuments: async () => documents,
      isIdle: async () => true,
      verifyOriginals: async () => true,
      closeDiscard: async () => { throw new Error('must not close dirty child'); },
    };
    await expect(recoverJob('job-1', runtime, new AbortController().signal)).resolves.toMatchObject({ safe: false });
    expect(documents[0]?.dirty).toBe(true);
  });

  it('closes only clean owned documents after idle certainty and preserves a foreign document', async () => {
    const closed: string[] = [];
    const runtime: RecoveryRuntime = {
      journal: { read: async () => [] },
      listDocuments: async () => [
        { id: 'child', path: '/job/child.psb', owned: true, dirty: false, parentId: null, depth: 0 },
        { id: 'user', path: '/Users/user.psd', owned: false, dirty: true, parentId: null },
      ].filter((document) => !closed.includes(document.id)),
      isIdle: async () => true,
      verifyOriginals: async () => true,
      closeDiscard: async (id) => { closed.push(id); },
      identity: { jobId: 'job-2', operationId: 'op-2', hostId: 'host-a', ownershipToken: 'token-a', installationDigest: 'a'.repeat(64), jobRoot: '/job' },
      ownershipLedger: [{ documentId: 'child', jobId: 'job-2', operationId: 'op-2', hostId: 'host-a', ownershipToken: 'token-a', installationDigest: 'a'.repeat(64), path: '/job/child.psb', parentId: null, depth: 0 }],
    };
    await expect(recoverJob('job-2', runtime, new AbortController().signal)).resolves.toMatchObject({ safe: true, outstanding: [] });
    expect(closed).toEqual(['child']);
  });

  it('returns a typed ambiguous result when a recovery primitive hangs', async () => {
    let marked = false;
    const runtime: RecoveryRuntime = {
      journal: { read: async () => [] },
      listDocuments: async () => new Promise<RecoveryDocument[]>(() => undefined),
      isIdle: async () => true,
      verifyOriginals: async () => true,
      closeDiscard: async () => undefined,
      timeoutMs: 5,
      onUnknown: () => { marked = true; },
      identity: { jobId: 'job-timeout', operationId: 'op-timeout', hostId: 'host-a', ownershipToken: 'token-a', installationDigest: 'a'.repeat(64), jobRoot: '/job' },
      ownershipLedger: [],
    };
    await expect(recoverJob('job-timeout', runtime, new AbortController().signal)).resolves.toMatchObject({ safe: false, ambiguous: true, error: { category: 'ambiguousState' } });
    expect(marked).toBe(true);
  });

  it('reconciles and releases only after backend recovery proves safe', async () => {
    let reconciled = 0;
    let marked = 0;
    const adapter = {
      lock: {
        runExclusive: async (_id: string, call: () => Promise<unknown>) => call(),
        reconcile: async () => { reconciled += 1; },
        markUnknownMutation: async () => { marked += 1; },
      },
      recover: async () => ({ safe: true, evidencePaths: [] }),
    } as unknown as BackendAdapter;
    const backend = new PhotoshopBackend(adapter);
    await expect(backend.recover('job-safe', new AbortController().signal)).resolves.toEqual({ safe: true, evidencePaths: [] });
    expect(reconciled).toBe(1);
    const failed = { ...adapter, recover: async () => ({ safe: false, evidencePaths: [] }) } as unknown as BackendAdapter;
    const failedBackend = new PhotoshopBackend(failed);
    await expect(failedBackend.recover('job-failed', new AbortController().signal)).resolves.toEqual({ safe: false, evidencePaths: [] });
    expect(marked).toBe(1);
  });
});
