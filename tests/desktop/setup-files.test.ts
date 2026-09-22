import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectAssets, validateSetupRoots, probeOutputDirectory } from '../../apps/desktop/src/main/setup-files.js';

describe('desktop setup file boundaries', () => {
  it('returns stable IDs and rejects output/input overlap', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ne-psd-setup-'));
    const input = join(root, 'input'); const output = join(root, 'output');
    mkdirSync(input); mkdirSync(output); writeFileSync(join(root, 'template.psd'), 'template'); writeFileSync(join(input, 'кот.png'), 'one'); writeFileSync(join(input, 'кот.jpg'), 'two'); writeFileSync(join(input, 'notes.txt'), 'skip');
    const first = await inspectAssets(input, 'assets'); const second = await inspectAssets(input, 'assets');
    expect(first.assets.map((asset) => asset.assetId)).toEqual(second.assets.map((asset) => asset.assetId));
    expect(first.assets).toHaveLength(2); expect(first.rejected[0]?.reason).toContain('Unsupported');
    expect(() => validateSetupRoots(join(root, 'template.psd'), input, input)).toThrow();
    expect(() => probeOutputDirectory(output)).not.toThrow();
  });

  it('rejects symlinked input roots and does not alter source files', () => {
    const root = mkdtempSync(join(tmpdir(), 'ne-psd-setup-')); const real = join(root, 'real'); const link = join(root, 'link');
    mkdirSync(real); writeFileSync(join(real, 'template.psd'), 'original'); symlinkSync(real, link);
    expect(() => validateSetupRoots(join(link, 'template.psd'), real, join(root, 'out'))).toThrow();
    expect(readFileSync(join(real, 'template.psd'), 'utf8')).toBe('original');
  });
});
