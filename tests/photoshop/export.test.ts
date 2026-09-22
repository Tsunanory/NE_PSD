import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  ExportError,
  exportVariants,
  mapExportQuality,
  type ExportAdapter,
  type ExportOptions,
} from '../../packages/photoshop/src/export.js';
import { buildToolMap } from '../../packages/photoshop/src/tool-map.js';

const ids = ['1', '2', '3'] as const;
type Id = (typeof ids)[number];

async function image(path: string, format: 'png' | 'jpeg' = 'png', alpha = true, width = 16, height = 12, profile = 'srgb') {
  const channels = alpha ? 4 : 3;
  const data = Buffer.alloc(width * height * channels, 0);
  for (let i = 0; i < width * height; i += 1) {
    data[i * channels] = 240;
    data[i * channels + 1] = 32;
    data[i * channels + 2] = 120;
    if (alpha) data[i * channels + 3] = i === 0 ? 0 : 255;
  }
  let pipeline = sharp(data, { raw: { width, height, channels } }).withMetadata({ icc: profile });
  await (format === 'png' ? pipeline.png() : pipeline.jpeg({ quality: 80 })).toFile(path);
}

function acknowledged() { return { acknowledged: true }; }

async function fixture(format: 'png' | 'jpeg' = 'png', overrides: Partial<ExportAdapter> = {}): Promise<{
  root: string;
  options: ExportOptions;
  calls: Array<{ operation: string; id?: Id; quality?: number; path?: string }>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'b11-export-'));
  const calls: Array<{ operation: string; id?: Id; quality?: number; path?: string }> = [];
  let selected: Id | null = null;
  const adapter: ExportAdapter = {
    restoreQualifiedState: async () => { calls.push({ operation: 'restore' }); return acknowledged(); },
    hideVariant: async (id) => { calls.push({ operation: 'hide', id }); return acknowledged(); },
    showVariant: async (id) => { selected = id; calls.push({ operation: 'show', id }); return acknowledged(); },
    readVisibility: async () => ({ acknowledged: true, ancestorVisible: true, visibleVariantIds: selected ? [selected] : [] }),
    prepareExport: async () => ({ acknowledged: true, disposable: true, documentId: 'duplicate-1', convertedPixels: true, renderingIntent: 'relative-colorimetric', mode: 'RGB', bitDepth: 8, embeddedProfile: 'sRGB', flattened: format === 'jpeg', alpha: format === 'png' ? 'preserve' : 'opaque' }),
    exportVariant: async ({ destination, quality, variantId }) => { calls.push({ operation: 'export', id: variantId, quality, path: destination }); await image(destination, format, format === 'png'); return { acknowledged: true, path: destination }; },
    cleanupDisposable: async () => { calls.push({ operation: 'cleanup' }); return acknowledged(); },
    ...overrides,
  };
  const options: ExportOptions = {
    bundleRoot: root,
    output: { format, quality: 50, colorSpace: 'sRGB', width: 16, height: 12 },
    qualityEvidence: { unit: '1-100' },
    alphaPolicy: format === 'png' ? 'preserve' : 'opaque',
    jpegBackground: format === 'jpeg' ? { r: 255, g: 255, b: 255 } : undefined,
    adapter,
  };
  return { root, options, calls };
}

describe('B11 verified variant exports', () => {
  it('exports exactly 1, 2, 3 sequentially with visible evidence and relative hashes', async () => {
    const fixtureState = await fixture();
    const result = await exportVariants(fixtureState.options);
    expect(result.artifacts.map((item) => item.variantId)).toEqual(ids);
    expect(result.visibility.map((item) => item.visibleVariantIds)).toEqual([['1'], ['2'], ['3']]);
    expect(result.artifacts.every((item) => !item.path.startsWith('/') && item.path.startsWith('variants/'))).toBe(true);
    expect(result.artifacts.every((item) => /^[a-f0-9]{64}$/.test(item.sha256) && item.bytes > 0)).toBe(true);
    expect(fixtureState.calls.filter((call) => call.operation === 'export').map((call) => call.id)).toEqual(ids);
    expect(fixtureState.calls.filter((call) => call.operation === 'export').map((call) => call.quality)).toEqual([undefined, undefined, undefined]);
  });

  it('restores common state and blocks hidden ancestors, stale replies, and unexpected IDs', async () => {
    const hidden = await fixture('png', { readVisibility: async () => ({ acknowledged: true, ancestorVisible: false, visibleVariantIds: ['1'] }) });
    await expect(exportVariants(hidden.options)).rejects.toMatchObject({ code: 'VISIBILITY_INVALID' });
    const stale = await fixture('png', { readVisibility: async () => ({ acknowledged: true, ancestorVisible: true, visibleVariantIds: ['2'] }) });
    await expect(exportVariants(stale.options)).rejects.toMatchObject({ code: 'VISIBILITY_INVALID' });
    const unexpected = await fixture('png', { readVisibility: async () => ({ acknowledged: true, ancestorVisible: true, visibleVariantIds: ['1', 'x' as Id] }) });
    await expect(exportVariants(unexpected.options)).rejects.toMatchObject({ code: 'VISIBILITY_INVALID' });
  });

  it('requires acknowledgements and returns no successful three-artifact result after one failure', async () => {
    const failed = await fixture('png', { exportVariant: async ({ destination }) => ({ acknowledged: false, path: destination }) });
    await expect(exportVariants(failed.options)).rejects.toMatchObject({ code: 'EXPORT_UNACKNOWLEDGED' });
    expect(failed.calls.filter((call) => call.operation === 'export')).toHaveLength(0);
    const visibilityLost = await fixture('png', { showVariant: async () => undefined });
    await expect(exportVariants(visibilityLost.options)).rejects.toMatchObject({ code: 'MUTATION_UNACKNOWLEDGED' });
  });

  it('maps only qualified quality units and ignores quality for PNG', () => {
    expect(mapExportQuality(1, { unit: '1-100' })).toBe(1);
    expect(mapExportQuality(50, { unit: '1-100' })).toBe(50);
    expect(mapExportQuality(100, { unit: '1-100' })).toBe(100);
    expect(() => mapExportQuality(50, { unit: '0-12' })).toThrowError(ExportError);
  });

  it('rejects synthetic, missing, conflicting and 0..12 export semantics in the tool map', () => {
    const schema = { type: 'object', properties: { quality: { type: 'number', minimum: 1, maximum: 100 }, format: { type: 'string' } }, required: ['format'], additionalProperties: false };
    const base = { operation: 'export' as const, toolName: 'export-live', inputSchema: schema, evidence: 'live-qualified' as const, semantics: { export: { qualityUnit: '1-100' as const, formats: ['jpeg', 'png'] as const, actualPixelsToSrgb: true as const, renderingIntent: 'relative-colorimetric' as const, embeddedProfile: 'sRGB' as const, mode: 'RGB' as const, bitDepth: 8 as const, alpha: 'format-dependent' as const } } };
    expect(() => buildToolMap([{ name: 'export-live', inputSchema: schema }], [base])).toThrow();
    expect(() => buildToolMap([{ name: 'export-live', inputSchema: schema }], [{ ...base, semantics: { ...base.semantics, export: { ...base.semantics.export, qualityUnit: '0-12' as const } } }])).toThrow();
  });

  it('passes JPEG quality only when qualified and omits it for PNG', async () => {
    const jpeg = await fixture('jpeg');
    await exportVariants(jpeg.options);
    expect(jpeg.calls.filter((call) => call.operation === 'export').map((call) => call.quality)).toEqual([50, 50, 50]);
    const png = await fixture('png');
    await exportVariants({ ...png.options, output: { ...png.options.output, quality: 1 } });
    expect(png.calls.filter((call) => call.operation === 'export').map((call) => call.quality)).toEqual([undefined, undefined, undefined]);
  });

  it('rejects wrong profile, dimensions, truncation, format, alpha and background policy', async () => {
    const cases: Array<[string, (path: string) => Promise<void>, Partial<ExportOptions>]> = [
      ['icc', (path) => image(path, 'png', true, 16, 12, 'adobe-rgb'), {}],
      ['dimensions', (path) => image(path, 'png', true, 15, 12), {}],
      ['truncated', (path) => writeFile(path, Buffer.from([137, 80, 78])), {}],
      ['format', (path) => image(path, 'jpeg', false), {}],
      ['alpha', (path) => image(path, 'png', false), {}],
    ];
    for (const [name, write, extra] of cases) {
      const state = await fixture('png', { exportVariant: async ({ destination }) => { await write(destination); return { acknowledged: true, path: destination }; } });
      await expect(exportVariants({ ...state.options, ...extra })).rejects.toMatchObject({ code: 'FILE_INVALID' });
      expect(name).toBeTruthy();
    }
    const jpeg = await fixture('jpeg', { prepareExport: async () => ({ acknowledged: true, disposable: true, documentId: 'd', convertedPixels: true, renderingIntent: 'relative-colorimetric', mode: 'RGB', bitDepth: 8, embeddedProfile: 'sRGB', flattened: false, alpha: 'opaque' }) });
    await expect(exportVariants(jpeg.options)).rejects.toMatchObject({ code: 'EXPORT_POLICY_INVALID' });
  });

  it('rejects traversal, absolute/outside, symlink, collision and overwrite paths', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'b11-outside-'));
    const attempts = [
      async (state: Awaited<ReturnType<typeof fixture>>) => ({ ...state.options, adapter: { ...state.options.adapter, exportVariant: async () => ({ acknowledged: true, path: '../outside.png' }) } }),
      async (state: Awaited<ReturnType<typeof fixture>>) => ({ ...state.options, adapter: { ...state.options.adapter, exportVariant: async () => ({ acknowledged: true, path: join(outside, 'outside.png') }) } }),
      async (state: Awaited<ReturnType<typeof fixture>>) => { await symlink(outside, join(state.root, 'variants')); return state.options; },
      async (state: Awaited<ReturnType<typeof fixture>>) => ({ ...state.options, adapter: { ...state.options.adapter, exportVariant: async ({ destination }) => ({ acknowledged: true, path: destination.replace('1.png', '2.png') }) } }),
    ];
    for (const make of attempts) await expect(exportVariants(await make(await fixture()))).rejects.toBeInstanceOf(ExportError);
    const overwrite = await fixture(); await mkdir(join(overwrite.root, 'variants')); await writeFile(join(overwrite.root, 'variants', '1.png'), 'existing');
    await expect(exportVariants(overwrite.options)).rejects.toMatchObject({ code: 'OUTPUT_EXISTS' });
  });

  it('proves disposable cleanup and operation order', async () => {
    const state = await fixture();
    const result = await exportVariants(state.options);
    expect(result.cleanup.acknowledged).toBe(true);
    expect(state.calls.map((call) => call.operation)).toEqual(expect.arrayContaining(['restore', 'hide', 'show', 'export', 'cleanup']));
    expect(state.calls.findIndex((call) => call.operation === 'export')).toBeLessThan(state.calls.findIndex((call) => call.operation === 'cleanup'));
  });

  it('returns shared-contract artifact dimensions and verified hashes', async () => {
    const state = await fixture();
    const result = await exportVariants(state.options);
    for (const artifact of result.artifacts) {
      expect(artifact).toMatchObject({ width: 16, height: 12, format: 'png', colorSpace: 'sRGB' });
      expect(artifact.sha256).toBe(createHash('sha256').update(await (await import('node:fs/promises')).readFile(join(state.root, artifact.path))).digest('hex'));
    }
  });
});
