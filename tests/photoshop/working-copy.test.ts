import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { join, basename, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  WorkingCopyError,
  assertWritableTarget,
  createWorkingCopy,
  sha256,
  type LinkedResource,
  type QualifiedLinkOperation,
} from '../../packages/photoshop/src/working-copy.js';

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ne-psd-b06-'));
  const source = join(root, 'source');
  const external = join(root, 'external');
  const other = join(root, 'other');
  const working = join(root, 'working');
  await Promise.all([writeFile(join(root, 'placeholder'), ''), writeFile(join(root, 'unused'), '')]);
  await (await import('node:fs/promises')).mkdir(join(source, 'nested'), { recursive: true });
  await (await import('node:fs/promises')).mkdir(join(external, 'one'), { recursive: true });
  await (await import('node:fs/promises')).mkdir(join(other, 'two'), { recursive: true });
  await (await import('node:fs/promises')).mkdir(working, { recursive: true });
  const master = join(source, 'мастер.psd');
  const first = join(external, 'one', 'shared.psb');
  const second = join(other, 'two', 'shared.psb');
  const outside = join(root, 'outside.psb');
  await writeFile(master, 'master');
  await writeFile(first, 'first');
  await writeFile(second, 'second');
  await writeFile(outside, 'outside');
  return { root, trustedRoot: root, source, external, other, working, master, first, second, outside };
}

function links(graph: Record<string, LinkedResource[]>): QualifiedLinkOperation {
  const calls: Array<{ parent: string; original: string; copy: string }> = [];
  return {
    calls,
    readLinks: async (path) => graph[path] ?? [],
    relink: async (parent, original, copy) => {
      calls.push({ parent, original, copy });
      graph[parent] = [];
    },
  };
}

describe('working-copy isolation', () => {
  it('copies a complete nested closure with collision-safe content-addressed names', async () => {
    const f = await fixture();
    const operation = links({
      [f.master]: [{ path: f.first, sourceKind: 'linked' }],
      [f.first]: [{ path: f.second, sourceKind: 'linked' }],
      [f.second]: [],
    });
    const result = await createWorkingCopy({ masterPath: f.master, trustedRoot: f.trustedRoot, attemptRoot: join(f.working, 'attempt-1'), operation });
    expect(result.masterPath).toContain('мастер.psd');
    expect(result.closure).toHaveLength(3);
    expect(new Set(result.closure.map((item) => basename(item.copyPath))).size).toBe(3);
    expect((await readFile(result.masterPath, 'utf8'))).toBe('master');
    expect(result.originalHashes.get(await realpath(f.first))).toBe(await sha256(f.first));
    expect(operation.calls.every((call) => call.parent.startsWith(result.attemptRoot))).toBe(true);
  });

  it('rejects symlink escapes, missing links, changed expected hashes and unknown linkage', async () => {
    const f = await fixture();
    const escape = join(f.source, 'escape.psb');
    await symlink(f.outside, escape);
    for (const resource of [
      { path: escape, sourceKind: 'linked' as const },
      { path: join(f.source, 'missing.psb'), sourceKind: 'linked' as const },
      { path: f.first, sourceKind: 'unknown' as const },
    ]) {
      const operation = links({ [f.master]: [resource] });
      await expect(createWorkingCopy({ masterPath: f.master, trustedRoot: f.source, attemptRoot: join(f.working, basename(resource.path)), operation }))
        .rejects.toMatchObject({ code: 'LINKED_SOURCE_UNISOLATED' });
    }
    const operation = links({ [f.master]: [{ path: f.first, sourceKind: 'linked' }] });
    await expect(createWorkingCopy({ masterPath: f.master, trustedRoot: f.trustedRoot, attemptRoot: join(f.working, 'hash'), expectedHashes: { [f.first]: '0'.repeat(64) }, operation }))
      .rejects.toMatchObject({ code: 'SOURCE_HASH_MISMATCH' });
  });

  it('fails closed for cycles and unavailable qualified relink/embed operations', async () => {
    const f = await fixture();
    const cycle = links({ [f.master]: [{ path: f.first, sourceKind: 'linked' }], [f.first]: [{ path: f.master, sourceKind: 'linked' }] });
    await expect(createWorkingCopy({ masterPath: f.master, trustedRoot: f.trustedRoot, attemptRoot: join(f.working, 'cycle'), operation: cycle }))
      .rejects.toMatchObject({ code: 'LINKED_SOURCE_UNISOLATED' });
    const noOperation = { readLinks: async (path: string) => path === f.master ? [{ path: f.first, sourceKind: 'linked' as const }] : [] };
    await expect(createWorkingCopy({ masterPath: f.master, trustedRoot: f.trustedRoot, attemptRoot: join(f.working, 'no-op'), operation: noOperation }))
      .rejects.toMatchObject({ code: 'LINKED_SOURCE_UNISOLATED' });
  });

  it('rejects a closure edge that remains external after relink', async () => {
    const f = await fixture();
    let copiedParent = '';
    const operation: QualifiedLinkOperation = {
      readLinks: async (path) => path === copiedParent ? [{ path: f.first, sourceKind: 'linked' }] : path === f.master ? [{ path: f.first, sourceKind: 'linked' }] : [],
      relink: async (parent) => { copiedParent = parent; },
    };
    await expect(createWorkingCopy({ masterPath: f.master, trustedRoot: f.trustedRoot, attemptRoot: join(f.working, 'external-after-relink'), operation }))
      .rejects.toMatchObject({ code: 'LINKED_SOURCE_UNISOLATED' });
  });

  it('rejects arbitrary internal files in the reread closure', async () => {
    const f = await fixture();
    let copiedParent = '';
    const operation: QualifiedLinkOperation = {
      readLinks: async (path) => path === copiedParent ? [{ path: `${copiedParent}/arbitrary.psb`, sourceKind: 'linked' }] : path === f.master ? [{ path: f.first, sourceKind: 'linked' }] : [],
      relink: async (parent) => { copiedParent = parent; },
    };
    await expect(createWorkingCopy({ masterPath: f.master, trustedRoot: f.trustedRoot, attemptRoot: join(f.working, 'internal-arbitrary'), operation }))
      .rejects.toMatchObject({ code: 'LINKED_SOURCE_UNISOLATED' });
  });

  it('uses a verified self-contained prepared copy and creates an exclusive fresh attempt', async () => {
    const f = await fixture();
    const prepared = join(f.source, 'prepared.psd');
    await writeFile(prepared, 'prepared');
    const operation = { ...links({ [prepared]: [] }), verifySelfContained: async () => true };
    const attemptRoot = join(f.working, 'prepared');
    const result = await createWorkingCopy({ masterPath: f.master, trustedRoot: f.trustedRoot, attemptRoot, expectedHashes: { [prepared]: digest('prepared') }, preparedTemplate: { path: prepared, sha256: digest('prepared'), selfContained: true }, operation });
    expect(await readFile(result.masterPath, 'utf8')).toBe('prepared');
    await expect(createWorkingCopy({ masterPath: f.master, trustedRoot: f.trustedRoot, attemptRoot, operation })).rejects.toMatchObject({ code: 'ATTEMPT_DIRECTORY_EXISTS' });
  });

  it('fails closed when a prepared self-contained claim is absent or rejected', async () => {
    const f = await fixture();
    const prepared = join(f.source, 'prepared.psd');
    await writeFile(prepared, 'prepared');
    const request = { masterPath: f.master, trustedRoot: f.trustedRoot, attemptRoot: join(f.working, 'prepared-verifier'), preparedTemplate: { path: prepared, sha256: digest('prepared'), selfContained: true }, operation: links({ [prepared]: [] }) };
    await expect(createWorkingCopy(request)).rejects.toMatchObject({ code: 'LINKED_SOURCE_UNISOLATED' });
    await expect(createWorkingCopy({ ...request, attemptRoot: join(f.working, 'prepared-verifier-false'), operation: { ...request.operation, verifySelfContained: async () => false } }))
      .rejects.toMatchObject({ code: 'LINKED_SOURCE_UNISOLATED' });
    const result = await createWorkingCopy({ ...request, attemptRoot: join(f.working, 'prepared-verifier-true'), operation: { ...request.operation, verifySelfContained: async () => true } });
    expect(result.originalHashes.get(await realpath(f.master))).toBe(digest('master'));
    expect(result.originalHashes.get(await realpath(prepared))).toBe(digest('prepared'));
  });

  it('denies every original or external target before save and preserves originals after child mutation', async () => {
    const f = await fixture();
    const operation = links({ [f.master]: [{ path: f.first, sourceKind: 'linked' }], [f.first]: [] });
    const result = await createWorkingCopy({ masterPath: f.master, trustedRoot: f.trustedRoot, attemptRoot: join(f.working, 'mutation'), operation });
    expect(await assertWritableTarget(f.master, result.attemptRoot)).toEqual({ allowed: false, code: 'LINKED_SOURCE_UNISOLATED' });
    expect(await result.assertWritableTarget(f.first)).toEqual({ allowed: false, code: 'LINKED_SOURCE_UNISOLATED' });
    expect(await result.assertWritableTarget(result.masterPath)).toEqual({ allowed: true });
    const firstOriginal = await realpath(f.first);
    await writeFile(result.closure.find((item) => item.originalPath === firstOriginal)!.copyPath, 'mutated child');
    expect(await sha256(f.master)).toBe(digest('master'));
    expect(await sha256(f.first)).toBe(digest('first'));
  });

  it('rehashes every original after qualified operations and rejects malicious mutation', async () => {
    const f = await fixture();
    const operation = links({ [f.master]: [{ path: f.first, sourceKind: 'linked' }], [f.first]: [] });
    operation.relink = async (parent) => {
      await writeFile(f.master, 'mutated master');
      await writeFile(f.first, 'mutated child');
      operation.calls!.push({ parent, original: f.first, copy: `${parent}/child` });
    };
    await expect(createWorkingCopy({ masterPath: f.master, trustedRoot: f.trustedRoot, attemptRoot: join(f.working, 'malicious-mutation'), operation }))
      .rejects.toMatchObject({ code: 'SOURCE_HASH_MISMATCH', evidence: { phase: 'post-isolation' } });
  });

  it('supports injected Windows path semantics without embedding host paths', async () => {
    const master = 'C:\\job\\мастер.psd';
    const first = 'C:\\job\\dep\\one\\shared.psb';
    const second = 'C:\\job\\dep\\two\\shared.psb';
    const hashes: Record<string, string> = { [master.toLowerCase()]: digest('master'), [first.toLowerCase()]: digest('first'), [second.toLowerCase()]: digest('second') };
    const copied: string[] = [];
    const copiedBytes: Record<string, Uint8Array> = {};
    const graph: Record<string, LinkedResource[]> = { [master.toLowerCase()]: [{ path: 'dep\\one\\shared.psb', sourceKind: 'linked' }, { path: second, sourceKind: 'linked' }], [first.toLowerCase()]: [], [second.toLowerCase()]: [] };
    const operation: QualifiedLinkOperation = {
      readLinks: async (path) => graph[path.toLowerCase()] ?? [],
      relink: async (parent) => { graph[parent.toLowerCase()] = []; },
    };
    const winPaths = {
      canonical: (value: string) => win32.normalize(value).toLowerCase(),
      contains: (root: string, target: string) => { const relative = win32.relative(root, target); return relative === '' || (!relative.startsWith('..') && !win32.isAbsolute(relative)); },
      resolve: (parent: string, child: string) => win32.resolve(win32.dirname(parent), child),
      dirname: (value: string) => win32.dirname(value),
      basename: (value: string) => win32.basename(value),
      join: (parent: string, child: string) => win32.join(parent, child),
      isAbsolute: (value: string) => win32.isAbsolute(value),
    };
    const operationWithTrace: QualifiedLinkOperation = { ...operation, relink: async (parent, original, copy) => { copied.push(parent, original, copy); await operation.relink!(parent, original, copy); } };
    const result = await createWorkingCopy({
      masterPath: master, trustedRoot: 'C:\\job', attemptRoot: 'C:\\attempt\\one', operation: operationWithTrace, pathSemantics: winPaths,
      filesystem: { readFile: async (path) => copiedBytes[path.toLowerCase()] ?? Buffer.from(path.toLowerCase()), hash: async (path) => hashes[path.toLowerCase()] ?? digest('master'), copy: async (source, destination) => { copied.push(destination); copiedBytes[destination.toLowerCase()] = Buffer.from(source.toLowerCase()); }, mkdir: async () => undefined, exists: async () => true },
    });
    expect(result.attemptRoot).toBe('c:\\attempt\\one');
    expect(result.closure).toHaveLength(3);
    expect(copied.every((path) => !path.includes('/'))).toBe(true);
    expect(copied.every((path) => !path.startsWith('/'))).toBe(true);
    expect(copied.some((path) => path.toLowerCase().includes('shared.psb'))).toBe(true);
  });

  it('uses the complete digest in destination names when prefixes collide', async () => {
    const f = await fixture();
    const firstHash = `${'a'.repeat(16)}${'1'.repeat(48)}`;
    const secondHash = `${'a'.repeat(16)}${'2'.repeat(48)}`;
    const firstPath = await realpath(f.first);
    const secondPath = await realpath(f.second);
    const operation = links({ [f.master]: [{ path: f.first, sourceKind: 'linked' }, { path: f.second, sourceKind: 'linked' }], [f.first]: [], [f.second]: [] });
    const result = await createWorkingCopy({
      masterPath: f.master, trustedRoot: f.trustedRoot, attemptRoot: join(f.working, 'hash-collision'), operation,
      filesystem: { readFile: async (path) => readFile(path), hash: async (path) => path === f.first || path === firstPath ? firstHash : path === f.second || path === secondPath ? secondHash : sha256(path), copy: async (source, destination) => { await (await import('node:fs/promises')).copyFile(source, destination); }, mkdir: async (path, options) => { await (await import('node:fs/promises')).mkdir(path, options); }, exists: async (path) => { try { await readFile(path); return true; } catch { return false; } }, remove: async () => undefined },
    });
    const first = result.closure.find((entry) => entry.originalPath === firstPath)!;
    const second = result.closure.find((entry) => entry.originalPath === secondPath)!;
    expect(first.copyPath).not.toBe(second.copyPath);
    expect(first.copyPath).toContain(firstHash);
    expect(second.copyPath).toContain(secondHash);
  });

  it('deduplicates a shared dependency by identity and rejects identity cycles through aliases', async () => {
    const f = await fixture();
    const shared = f.outside;
    const dag = links({
      [f.master]: [{ path: f.first, sourceKind: 'linked' }, { path: f.second, sourceKind: 'linked' }],
      [f.first]: [{ path: shared, sourceKind: 'linked', identity: 'shared-resource' }],
      [f.second]: [{ path: shared, sourceKind: 'linked', identity: 'shared-resource' }],
      [shared]: [],
    });
    const result = await createWorkingCopy({ masterPath: f.master, trustedRoot: f.trustedRoot, attemptRoot: join(f.working, 'dag'), operation: dag });
    expect(result.closure.filter((entry) => entry.identity === 'shared-resource')).toHaveLength(1);
    const aliasCycle = links({ [f.master]: [{ path: f.first, sourceKind: 'linked', identity: 'cycle-resource' }], [f.first]: [{ path: f.outside, sourceKind: 'linked', identity: 'cycle-resource' }] });
    await expect(createWorkingCopy({ masterPath: f.master, trustedRoot: f.trustedRoot, attemptRoot: join(f.working, 'alias-cycle'), operation: aliasCycle }))
      .rejects.toMatchObject({ code: 'LINKED_SOURCE_UNISOLATED' });
  });
});

describe('working-copy error evidence', () => {
  it('exposes deterministic code and evidence', () => {
    const error = new WorkingCopyError('LINKED_SOURCE_UNISOLATED', 'unresolved linked source', { path: 'resource.psb' });
    expect(error.code).toBe('LINKED_SOURCE_UNISOLATED');
    expect(error.evidence).toEqual({ path: 'resource.psb' });
  });
});
