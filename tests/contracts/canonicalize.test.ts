import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  digestJson,
  digestFile,
  validateManifestEntries,
  verifyManifestFiles,
} from '@ne-psd/contracts';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('RFC 8785 canonicalization and evidence integrity', () => {
  it('is independent of object key order and preserves Unicode', async () => {
    expect(canonicalize({ b: 2, a: 'Ж' })).toBe(canonicalize({ a: 'Ж', b: 2 }));
    expect(await digestJson({ b: 2, a: 'Ж' })).toBe(await digestJson({ a: 'Ж', b: 2 }));
  });

  it('uses canonical numeric handling and rejects non-finite values', () => {
    expect(canonicalize({ a: -0, b: 1e-7, c: 1e21 })).toBe('{"a":0,"b":1e-7,"c":1e+21}');
    expect(() => canonicalize({ value: Number.NaN })).toThrow();
    expect(() => canonicalize({ value: Number.POSITIVE_INFINITY })).toThrow();
  });

  it('excludes only the selected self-hash field', () => {
    expect(canonicalize({ a: 1, profileSha256: 'old' }, { excludeKeys: ['profileSha256'] })).toBe('{"a":1}');
  });

  it('rejects unsafe manifest paths and enforces sorted unique entries', () => {
    expect(validateManifestEntries([
      { relativePath: 'b.txt', sha256: 'a'.repeat(64), bytes: 1, role: 'trace' },
      { relativePath: 'a.txt', sha256: 'b'.repeat(64), bytes: 1, role: 'trace' },
    ]).success).toBe(false);
    expect(validateManifestEntries([{ relativePath: '../escape', sha256: 'a'.repeat(64), bytes: 1, role: 'trace' }]).success).toBe(false);
    expect(validateManifestEntries([{ relativePath: 'a.txt', sha256: 'a'.repeat(64), bytes: 1, role: 'trace' }]).success).toBe(true);
  });

  it('detects changed trace bytes and symlink escape', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ne-psd-contract-'));
    await mkdir(join(root, 'bundle'));
    await writeFile(join(root, 'bundle', 'trace.json'), '{"ok":true}\n');
    const trace = { relativePath: 'bundle/trace.json', sha256: await digestFile(join(root, 'bundle', 'trace.json')), bytes: 12, role: 'trace' as const };
    expect((await verifyManifestFiles(root, [trace])).success).toBe(true);
    await writeFile(join(root, 'bundle', 'trace.json'), '{"ok":false}\n');
    expect((await verifyManifestFiles(root, [trace])).success).toBe(false);
    await writeFile(join(root, 'outside.txt'), 'outside');
    await symlink(join(root, 'outside.txt'), join(root, 'bundle', 'link.txt'));
    expect((await verifyManifestFiles(root, [{ ...trace, relativePath: 'bundle/link.txt' }])).success).toBe(false);
  });
});
