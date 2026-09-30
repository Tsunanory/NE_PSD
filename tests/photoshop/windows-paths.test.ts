import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPinnedLaunchParameters } from '../../packages/photoshop/src/mcp-client.js';
import { assertWritableTarget, createWorkingCopy, type LinkedResource, type PathSemantics, type WorkingCopyFileSystem } from '../../packages/photoshop/src/working-copy.js';

const key = (path: string): string => win32.normalize(path).toLowerCase();
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const paths: PathSemantics = {
  canonical: key,
  contains: (root, target) => { const rel = win32.relative(key(root), key(target)); return rel === '' || (rel !== '..' && !rel.startsWith(`..\\`) && !win32.isAbsolute(rel)); },
  resolve: (parent, child) => win32.resolve(win32.dirname(parent), child),
  dirname: win32.dirname,
  basename: win32.basename,
  join: win32.join,
  isAbsolute: win32.isAbsolute,
};

function memoryFiles(source: Record<string, string>) {
  const files = new Map(Object.entries(source).map(([path, value]) => [key(path), Buffer.from(value)]));
  const copies: string[] = [];
  const filesystem: WorkingCopyFileSystem = {
    readFile: async (path) => { const bytes = files.get(key(path)); if (!bytes) throw new Error(`missing ${path}`); return bytes; },
    copy: async (sourcePath, destination) => { const bytes = files.get(key(sourcePath)); if (!bytes) throw new Error(`missing ${sourcePath}`); files.set(key(destination), Buffer.from(bytes)); copies.push(key(destination)); },
    mkdir: async () => undefined,
    exists: async (path) => files.has(key(path)),
    remove: async () => undefined,
  };
  return { files, copies, filesystem };
}

describe('B16 Windows lexical paths on a non-Windows host', () => {
  it('isolates a Cyrillic, whitespace and long-name linked closure without basename collisions', async () => {
    const master = 'C:\\NE PSD\\шаблоны\\мокап_готово.psd';
    const first = 'C:\\NE PSD\\шаблоны\\слой один\\' + 'д'.repeat(120) + '.psb';
    const second = 'C:\\NE PSD\\шаблоны\\слой два\\' + 'д'.repeat(120) + '.psb';
    const store = memoryFiles({ [master]: 'master bytes', [first]: 'first bytes', [second]: 'second bytes' });
    const links = new Map<string, LinkedResource[]>([[key(master), [{ path: first, sourceKind: 'linked' }, { path: second, sourceKind: 'linked' }]]]);
    const result = await createWorkingCopy({
      masterPath: master,
      trustedRoot: 'C:\\NE PSD\\шаблоны',
      attemptRoot: 'C:\\NE PSD\\job\\attempt 1',
      pathSemantics: paths,
      filesystem: store.filesystem,
      operation: {
        readLinks: async (path) => links.get(key(path)) ?? [],
        relink: async (parent) => { links.set(key(parent), []); },
      },
    });
    expect(result.closure).toHaveLength(3);
    expect(new Set(result.closure.map((entry) => key(entry.copyPath))).size).toBe(3);
    expect(result.closure.every((entry) => paths.contains(result.attemptRoot, entry.copyPath))).toBe(true);
    expect(store.copies).toHaveLength(3);
    expect(store.files.get(key(master))).toEqual(Buffer.from('master bytes'));
    expect(result.originalHashes.get(key(first))).toBe(hash(Buffer.from('first bytes')));
    expect(await assertWritableTarget(master, result.attemptRoot, paths)).toEqual({ allowed: false, code: 'LINKED_SOURCE_UNISOLATED' });
  });

  it('coalesces case-only aliases and rejects a linked dependency on another volume', async () => {
    const master = 'C:\\NE PSD\\шаблоны\\мокап_готово.psd';
    const dependency = 'C:\\NE PSD\\шаблоны\\Art.psb';
    const store = memoryFiles({ [master]: 'master', [dependency]: 'art' });
    const caseAlias = await createWorkingCopy({
      masterPath: master, trustedRoot: 'C:\\NE PSD\\шаблоны', attemptRoot: 'C:\\job\\case-alias', pathSemantics: paths, filesystem: store.filesystem,
      operation: { readLinks: async (path) => key(path) === key(master) ? [{ path: dependency, sourceKind: 'linked' }, { path: 'art.PSB', sourceKind: 'linked' }] : [], relink: async () => undefined },
    });
    expect(caseAlias.closure).toHaveLength(2);
    expect(store.copies).toHaveLength(2);

    const foreign = 'D:\\external\\asset.psb';
    const foreignStore = memoryFiles({ [master]: 'master', [foreign]: 'foreign' });
    await expect(createWorkingCopy({
      masterPath: master, trustedRoot: 'C:\\NE PSD\\шаблоны', attemptRoot: 'C:\\job\\foreign', pathSemantics: paths, filesystem: foreignStore.filesystem,
      operation: { readLinks: async (path) => key(path) === key(master) ? [{ path: foreign, sourceKind: 'linked' }] : [], relink: async () => undefined },
    })).rejects.toMatchObject({ code: 'LINKED_SOURCE_UNISOLATED' });
    expect(foreignStore.copies).toHaveLength(0);
  });

  it('passes Unicode and spaces as distinct argv values to the pinned launcher', () => {
    const server = 'C:\\NE PSD\\node_modules\\@alisaitteke\\photoshop-mcp\\dist\\index.js';
    const source = 'C:\\NE PSD\\шаблоны\\мокап_готово.psd';
    const launch = buildPinnedLaunchParameters({ nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe', serverEntry: server, explicitArgs: ['--source', source] });
    expect(launch).toEqual({ command: 'C:\\Program Files\\nodejs\\node.exe', args: [server, '--source', source] });
    expect(() => buildPinnedLaunchParameters({ nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe', serverEntry: server, explicitArgs: ['--source', `${source};del`] })).toThrowError(/unsafe shell syntax/);
  });
});
