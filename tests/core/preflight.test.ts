import { describe, expect, it } from 'vitest';
import { chmod, mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enumerateInputs, readValidatedSource, validateSourceSnapshot } from '@ne-psd/core';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ne-psd-preflight-'));
  await mkdir(join(root, 'nested', 'upper'), { recursive: true });
  await mkdir(join(root, 'nested', 'lower'));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  await writeFile(join(root, 'nested', 'upper', 'A.png'), png);
  await writeFile(join(root, 'nested', 'lower', 'a.png'), png);
  return root;
}

describe('preflight', () => {
  it('enumerates recursively in reproducible order and snapshots content', async () => {
    const root = await fixture();
    await chmod(root, 0o555);
    const result = await enumerateInputs(root, { extensions: ['.png'] });
    expect(result.errors).toEqual([]);
    expect(result.files.map((file) => file.relativePath)).toEqual(['nested/lower/a.png', 'nested/upper/A.png']);
    await writeFile(join(root, 'nested', 'lower', 'a.png'), Buffer.from('changed'));
    await expect(validateSourceSnapshot(result.files[0]!)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
  });

  it('rejects zero-byte, corrupt, reserved-name, unsafe and output-root inputs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ne-psd-preflight-'));
    await writeFile(join(root, 'CON.png'), Buffer.from('bad'));
    await writeFile(join(root, 'empty.png'), Buffer.alloc(0));
    const outside = await mkdtemp(join(tmpdir(), 'ne-psd-outside-'));
    await symlink(outside, join(root, 'escape'));
    const result = await enumerateInputs(root, { extensions: ['.png'], outputRoot: join(root, 'out'), sourceRootPolicy: async () => undefined });
    expect(result.errors.map((error) => error.code)).toEqual(expect.arrayContaining(['WINDOWS_RESERVED_NAME', 'ZERO_BYTE', 'SYMLINK_ESCAPE']));
    expect(result.files.some((file) => file.relativePath === 'out/x.png')).toBe(false);
  });

  it('requires a PSD validator and rejects truncated raster data through the decoder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ne-psd-validator-'));
    await writeFile(join(root, 'truncated.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]));
    await writeFile(join(root, 'candidate.psd'), Buffer.from('8BPS' + '0'.repeat(30)));
    await chmod(root, 0o555);
    const result = await enumerateInputs(root, { extensions: ['.png', '.psd'] });
    expect(result.errors.map((error) => error.code)).toEqual(expect.arrayContaining(['CORRUPT_IMAGE', 'PSD_VALIDATOR_REQUIRED']));
  });

  it('returns only bytes that still match the selected digest at the backend boundary', async () => {
    const root = await fixture();
    await chmod(root, 0o555);
    const result = await enumerateInputs(root, { extensions: ['.png'] });
    const selected = result.files[0]!;
    const bytes = await readValidatedSource(selected);
    expect(bytes.byteLength).toBe(selected.bytes);
    await writeFile(selected.absolutePath, Buffer.from('retargeted'));
    await expect(readValidatedSource(selected)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
  });
});
