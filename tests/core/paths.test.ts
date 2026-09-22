import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertConfinedPath, validateOutputRoot, validateOutputPathBudget, validateWindowsComponent } from '@ne-psd/core';

describe('Windows-safe confined paths', () => {
  it('rejects reserved names, trailing dot/space, and traversal', () => {
    expect(() => validateWindowsComponent('CON')).toThrowError(/reserved/i);
    expect(() => validateWindowsComponent('name.')).toThrowError(/trailing/i);
    expect(() => validateWindowsComponent('name ')).toThrowError(/trailing/i);
    expect(() => assertConfinedPath('/tmp/root', '/tmp/root/../escape')).toThrowError(/escapes|outside/i);
  });

  it('rejects output inside the immutable input root and read-only output folders', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ne-psd-paths-'));
    const output = join(root, 'output');
    await mkdir(output);
    await expect(validateOutputRoot(root, root)).rejects.toMatchObject({ code: 'OUTPUT_INSIDE_INPUT' });
    await chmod(output, 0o555);
    await expect(validateOutputRoot(join(root, 'input'), output)).rejects.toMatchObject({ code: 'OUTPUT_NOT_WRITABLE' });
    await writeFile(join(root, 'marker'), 'ok');
  });

  it('enforces the final Windows-safe output path budget', () => {
    expect(() => validateOutputPathBudget('/tmp/output', 'asset--abc', '1.png', 20)).toThrowError(/length/i);
  });

  it('rejects an output-root symlink that resolves inside the input tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ne-psd-output-link-'));
    const input = join(root, 'input');
    await mkdir(input);
    const output = join(root, 'output');
    await symlink(input, output);
    await expect(validateOutputRoot(input, output)).rejects.toMatchObject({ code: 'OUTPUT_INSIDE_INPUT' });
  });
});
