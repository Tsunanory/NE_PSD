import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { createAttemptWorkspace, copyOwnedFile, verifyWorkspaceFile, cleanupAttemptWorkspace } from '@ne-psd/core';

const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'ne-psd-owned-copy-'));
  const output = join(directory, 'output');
  const source = join(directory, 'source');
  await mkdir(output); await mkdir(source);
  const canonicalRoot = await realpath(source);
  const info = await stat(canonicalRoot);
  const binding = { rootId: 'input', canonicalRoot, canonicalRootIdentity: createHash('sha256').update(`${canonicalRoot}|${info.dev}|${info.ino}`).digest('hex') };
  onTestFinished(async () => rm(directory, { recursive: true, force: true }));
  return { directory, output, source, binding };
}

describe('owned attempt workspace', () => {
  it('creates a fresh attempt and copies exact source and dependency bytes', async () => {
    const f = await fixture();
    const sourceBytes = Buffer.from('source');
    const linkedBytes = Buffer.from('linked');
    await mkdir(join(f.source, 'assets'));
    await writeFile(join(f.source, 'assets', 'source.png'), sourceBytes);
    await writeFile(join(f.source, 'assets', 'linked.psb'), linkedBytes);
    const workspace = await createAttemptWorkspace(f.output, 'job', 'asset', 1);
    const source = await copyOwnedFile(workspace, f.binding, { rootId: 'input', relativePath: 'assets/source.png', sha256: digest(sourceBytes) }, sourceBytes.length, 'scratch/input/source.png');
    const linked = await copyOwnedFile(workspace, f.binding, { rootId: 'input', relativePath: 'assets/linked.psb', sha256: digest(linkedBytes) }, linkedBytes.length, 'scratch/input/linked.psb');
    expect(await readFile(source)).toEqual(sourceBytes);
    expect(await readFile(linked)).toEqual(linkedBytes);
    expect(await verifyWorkspaceFile(workspace, 'scratch/input/source.png', digest(sourceBytes))).toEqual(sourceBytes);
    await expect(createAttemptWorkspace(f.output, 'job', 'asset', 1)).rejects.toThrow(/exists|fresh/i);
    await cleanupAttemptWorkspace(workspace);
    await expect(readFile(source)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects changed sources and symlinked dependency paths before copying', async () => {
    const f = await fixture();
    await mkdir(join(f.source, 'assets'));
    await writeFile(join(f.source, 'assets', 'source.png'), 'changed');
    await symlink(f.directory, join(f.source, 'assets', 'link'));
    const workspace = await createAttemptWorkspace(f.output, 'job', 'asset', 1);
    await expect(copyOwnedFile(workspace, f.binding, { rootId: 'input', relativePath: 'assets/source.png', sha256: digest(Buffer.from('original')) }, 8, 'scratch/input/source.png')).rejects.toThrow(/digest|changed/i);
    await expect(copyOwnedFile(workspace, f.binding, { rootId: 'input', relativePath: 'assets/link/file.psb', sha256: digest(Buffer.from('data')) }, 4, 'scratch/input/file.psb')).rejects.toThrow(/symlink|escape/i);
  });
});
