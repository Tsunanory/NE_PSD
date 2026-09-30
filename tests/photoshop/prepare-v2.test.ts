import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { PreparedInputManifestV2Schema, type PrepareRequestV2 } from '@ne-psd/contracts';
import { ASSET_CLOSURE_PROOF_V2_PATH, PREPARED_INPUT_MANIFEST_V2_PATH, prepareOwnedInputV2, sourceRootIdentity, type AssetLinkScanner } from '../../packages/photoshop/src/prepare-v2.js';
import { readFixture } from '../fixtures/read-fixture.js';

const sha = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex');
const png = async (): Promise<Buffer> => sharp({ create: { width: 3, height: 2, channels: 4, background: { r: 20, g: 30, b: 40, alpha: 1 } } }).png().toBuffer();

async function fixture(name = 'вход.png', bytes?: Buffer) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ne-psd-prepare-v2-')));
  const sourceRoot = join(root, 'источники');
  const stagingDirectory = join(root, 'attempt');
  await mkdir(sourceRoot);
  await mkdir(stagingDirectory);
  const source = join(sourceRoot, name);
  const content = bytes ?? await png();
  await writeFile(source, content);
  const info = await stat(sourceRoot);
  const sourceRootIdentity = sha(sourceRoot + '|' + info.dev + '|' + info.ino);
  const baseline = readFixture<PrepareRequestV2>('prepare-request.v2.valid.json');
  const request: PrepareRequestV2 = {
    ...baseline, stagingDirectory,
    asset: { ...baseline.asset, source: { rootId: 'fixture-root', relativePath: name, sha256: sha(content) }, sourceBytes: content.byteLength },
    sourceRoot: { rootId: 'fixture-root', path: sourceRoot, identity: sourceRootIdentity },
  };
  return { root, sourceRoot, stagingDirectory, source, request };
}
const unusedScanner: AssetLinkScanner = { readLinks: async () => { throw new Error('raster must not invoke Photoshop scanner'); } };
const code = (result: Awaited<ReturnType<typeof prepareOwnedInputV2>>): string | undefined => result.status === 'blocked' ? result.errors[0]?.code : undefined;

describe('v2 read-only per-asset closure producer', () => {
  it('proves a decoded raster has no links and writes an actual digest-bound closure file', async () => {
    const f = await fixture();
    const before = await readFile(f.source);
    const result = await prepareOwnedInputV2(f.request, unusedScanner, new AbortController().signal);
    expect(PreparedInputManifestV2Schema.parse(result)).toEqual(result);
    expect(result.status).toBe('prepared');
    if (result.status !== 'prepared') return;
    expect(result.dependencies).toEqual([]);
    expect(result.closureComplete).toBe(true);
    const proof = await readFile(join(f.stagingDirectory, result.closureProof.relativePath));
    expect(sha(proof)).toBe(result.closureProof.sha256);
    expect(result.closureProof.relativePath).toBe(ASSET_CLOSURE_PROOF_V2_PATH);
    expect(JSON.parse(await readFile(join(f.stagingDirectory, PREPARED_INPUT_MANIFEST_V2_PATH), 'utf8'))).toEqual(result);
    expect(await sourceRootIdentity(f.sourceRoot)).toEqual({ root: f.sourceRoot, identity: f.request.sourceRoot.identity });
    expect(JSON.parse(proof.toString())).toMatchObject({ sourceRootIdentity: f.request.sourceRoot.identity, source: { sha256: f.request.asset.source.sha256 }, closureComplete: true });
    expect(await readFile(f.source)).toEqual(before);
  });

  it('enumerates nested PSD/PSB links and Unicode dependency bytes before copying', async () => {
    const f = await fixture('основа.psd', Buffer.from('psd-root'));
    const nested = join(f.sourceRoot, 'слои');
    await mkdir(nested);
    const psb = join(nested, 'ребёнок.psb');
    const raster = join(nested, 'картинка.png');
    await writeFile(psb, 'psb-child');
    await writeFile(raster, await png());
    const calls: string[] = [];
    const scanner: AssetLinkScanner = {
      readLinks: async (path) => {
        calls.push(path);
        return { sourceSha256: sha(await readFile(path)), complete: true, links: path === f.source ? [{ path: 'слои/ребёнок.psb', sourceKind: 'linked' }] : [{ path: raster, sourceKind: 'linked' }] };
      },
    };
    const result = await prepareOwnedInputV2(f.request, scanner, new AbortController().signal);
    expect(result.status).toBe('prepared');
    if (result.status !== 'prepared') return;
    expect(calls).toEqual([f.source, psb]);
    expect(result.dependencies.map((item) => item.original.relativePath).sort()).toEqual(['слои/картинка.png', 'слои/ребёнок.psb']);
    const proof = JSON.parse(await readFile(join(f.stagingDirectory, result.closureProof.relativePath), 'utf8'));
    expect(proof.observedLinks).toHaveLength(2);
    expect(proof.dependencies.map((item: { bytes: number }) => item.bytes).every((bytes: number) => bytes > 0)).toBe(true);
    expect(await readFile(f.source, 'utf8')).toBe('psd-root');
  });

  it('blocks when a scanner aborts its signal but returns a complete result', async () => {
    const f = await fixture('основа.psd', Buffer.from('psd-root'));
    const controller = new AbortController();
    const scanner: AssetLinkScanner = {
      readLinks: async () => {
        controller.abort();
        return { sourceSha256: sha('psd-root'), complete: true, links: [] };
      },
    };
    const result = await prepareOwnedInputV2(f.request, scanner, controller.signal);
    expect(code(result)).toBe('CANCELLED');
    await expect(readFile(join(f.stagingDirectory, ASSET_CLOSURE_PROOF_V2_PATH))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(f.stagingDirectory, PREPARED_INPUT_MANIFEST_V2_PATH))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('blocks an unproven empty scan, unknown link, missing link and cycle without a proof file', async () => {
    const f = await fixture('основа.psd', Buffer.from('psd-root'));
    const broken: AssetLinkScanner[] = [
      { readLinks: async () => ({ sourceSha256: sha('psd-root'), complete: false as true, links: [] }) },
      { readLinks: async () => ({ sourceSha256: sha('psd-root'), complete: true, links: [{ path: null, sourceKind: 'unknown' }] }) },
      { readLinks: async () => ({ sourceSha256: sha('psd-root'), complete: true, links: [{ path: 'missing.psb', sourceKind: 'linked' }] }) },
      { readLinks: async () => ({ sourceSha256: sha('psd-root'), complete: true, links: [{ path: f.source, sourceKind: 'linked' }] }) },
    ];
    const expected = ['LINK_SCAN_UNAVAILABLE', 'LINK_UNKNOWN', 'SOURCE_MISSING', 'LINK_CYCLE'];
    for (let index = 0; index < broken.length; index++) {
      const result = await prepareOwnedInputV2(f.request, broken[index]!, new AbortController().signal);
      expect(code(result)).toBe(expected[index]);
      await expect(readFile(join(f.stagingDirectory, 'checks', 'asset-closure.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('rejects symlinked, changed and identity-mismatched originals', async () => {
    const f = await fixture('основа.psd', Buffer.from('psd-root'));
    const outside = join(f.root, 'outside.psd');
    await writeFile(outside, 'outside');
    const link = join(f.sourceRoot, 'link.psd');
    await symlink(outside, link);
    const linkRequest = { ...f.request, asset: { ...f.request.asset, source: { ...f.request.asset.source, relativePath: 'link.psd', sha256: sha('outside') }, sourceBytes: 7 } };
    expect(code(await prepareOwnedInputV2(linkRequest, unusedScanner, new AbortController().signal))).toBe('SOURCE_SYMLINK');
    expect(code(await prepareOwnedInputV2({ ...f.request, sourceRoot: { ...f.request.sourceRoot, identity: '0'.repeat(64) } }, unusedScanner, new AbortController().signal))).toBe('SOURCE_ROOT_CHANGED');
    const mutating: AssetLinkScanner = { readLinks: async (path) => { await writeFile(path, 'changed'); return { sourceSha256: sha('psd-root'), complete: true, links: [] }; } };
    expect(code(await prepareOwnedInputV2(f.request, mutating, new AbortController().signal))).toBe('SOURCE_CHANGED');
  });

  it('rejects image bytes that do not decode as their extension', async () => {
    const f = await fixture('wrong.jpg', await png());
    expect(code(await prepareOwnedInputV2(f.request, unusedScanner, new AbortController().signal))).toBe('RASTER_INVALID');
  });

  it('never overwrites an earlier operation manifest in the same attempt', async () => {
    const f = await fixture();
    const first = await prepareOwnedInputV2(f.request, unusedScanner, new AbortController().signal);
    expect(first.status).toBe('prepared');
    const second = await prepareOwnedInputV2({ ...f.request, operationId: 'other-operation' }, unusedScanner, new AbortController().signal);
    expect(code(second)).toBe('PROOF_ALREADY_EXISTS');
    const onDisk = JSON.parse(await readFile(join(f.stagingDirectory, PREPARED_INPUT_MANIFEST_V2_PATH), 'utf8'));
    expect(onDisk.operationId).toBe(f.request.operationId);
  });
});
