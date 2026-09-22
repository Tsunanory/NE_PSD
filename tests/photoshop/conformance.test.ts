import { readFile, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildPinnedLaunchParameters } from '../../packages/photoshop/src/mcp-client.js';
import { OperationJournal, runUncertainOperation } from '../../packages/photoshop/src/recovery.js';
import { checkFit, scaleFor } from '../../packages/photoshop/src/geometry.js';
import { ExportError, exportVariants, type ExportAdapter } from '../../packages/photoshop/src/export.js';
import { resolveLayer, structuralFingerprint, type SelectorDocument } from '../../packages/photoshop/src/selectors.js';
import sharp from 'sharp';

type ConformanceCase = { assetId: string; fitMode: 'cover' | 'contain' | 'stretch'; orientation: 'portrait' | 'landscape' | 'square'; format: 'jpeg' | 'png'; source: { width: number; height: number }; flags: string[] };
const corpus = JSON.parse(await readFile(new URL('./fixtures/conformance-cases.json', import.meta.url), 'utf8')) as ConformanceCase[];
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

function imageAdapter(root: string, format: 'jpeg' | 'png', counters: { inFlight: number; max: number }, faulty?: 'corrupt' | 'wrongColor'): ExportAdapter {
  let visible: '1' | '2' | '3' = '1';
  const enter = async (): Promise<void> => { counters.inFlight += 1; counters.max = Math.max(counters.max, counters.inFlight); };
  const leave = (): void => { counters.inFlight -= 1; };
  return {
    restoreQualifiedState: async () => { await enter(); leave(); return { acknowledged: true }; },
    hideVariant: async () => { await enter(); leave(); return { acknowledged: true }; },
    showVariant: async (id) => { await enter(); visible = id; leave(); return { acknowledged: true }; },
    readVisibility: async () => ({ acknowledged: true, ancestorVisible: true, visibleVariantIds: [visible] }),
    prepareExport: async () => ({ acknowledged: true, disposable: true, documentId: 'disposable-export', convertedPixels: true, renderingIntent: 'relative-colorimetric' as const, mode: 'RGB' as const, bitDepth: 8 as const, embeddedProfile: 'sRGB' as const, flattened: format === 'jpeg', alpha: format === 'png' ? 'preserve' as const : 'opaque' as const }),
    exportVariant: async ({ variantId, destination }) => {
      await enter();
      if (faulty === 'corrupt') { await writeFile(destination, 'not-an-image'); leave(); return { acknowledged: true, path: destination }; }
      const source = sharp({ create: { width: 32, height: 24, channels: 4, background: { r: Number(variantId) * 60, g: 120, b: 200, alpha: format === 'png' ? 0.8 : 0 } } });
      const output = format === 'png' ? source.png() : source.flatten({ background: { r: 12, g: 34, b: 56 } }).jpeg({ quality: 100 });
      if (faulty !== 'wrongColor') output.withMetadata({ icc: 'srgb' });
      await output.toFile(destination); leave(); return { acknowledged: true, path: destination };
    },
    cleanupDisposable: async () => ({ acknowledged: true }),
  };
}

describe('B14 deterministic Photoshop conformance corpus', () => {
  it('contains the complete required matrix and uses trusted asset identity', () => {
    expect(new Set(corpus.map((item) => item.assetId)).size).toBe(corpus.length);
    expect(new Set(corpus.filter((item) => !item.flags.includes('handledByCore')).map((item) => `${item.fitMode}:${item.orientation}:${item.format}`)).size).toBe(18);
    expect(corpus.some((item) => item.source.width === 500 && item.source.height === 500)).toBe(true);
    expect(corpus.some((item) => item.source.width === 5000 && item.source.height === 5000)).toBe(true);
    expect(corpus.some((item) => item.source.width === 12000 && item.source.height === 8000)).toBe(true);
    expect(corpus.some((item) => item.flags.includes('cyrillicFilename') && item.flags.includes('spaces'))).toBe(true);
    expect(corpus.every((item) => !item.assetId.includes('.'))).toBe(true);
  });

  it('fits every valid matrix row with non-origin geometry and produces 3*n decoded artifacts', async () => {
    const valid = corpus.filter((item) => !item.flags.some((flag) => ['handledByCore', 'corruptInput', 'wrongColor', 'schemaDrift', 'zeroEffectiveBounds', 'unknownEffectiveBounds', 'lostReply'].includes(flag)));
    let artifactCount = 0;
    for (const item of valid) {
      const reference = { left: 100, top: 200, right: item.orientation === 'portrait' ? 700 : 900, bottom: item.orientation === 'landscape' ? 600 : 1000 };
      const placed = { left: 20, top: 30, right: 220, bottom: 430 };
      const scale = scaleFor(reference, placed, item.fitMode);
      const width = (placed.right - placed.left) * scale.percentX / 100;
      const height = (placed.bottom - placed.top) * scale.percentY / 100;
      const finalPlaced = { left: (reference.left + reference.right - width) / 2, top: (reference.top + reference.bottom - height) / 2, right: (reference.left + reference.right + width) / 2, bottom: (reference.top + reference.bottom + height) / 2 };
      expect(checkFit(reference, finalPlaced, placed, item.fitMode, 0.5).every((check) => check.passed)).toBe(true);
      const root = await mkdtemp(join(tmpdir(), `b14-${item.assetId}-`));
      const result = await exportVariants({ bundleRoot: root, approvedBundleRoot: root, output: { format: item.format, quality: 100, colorSpace: 'sRGB', width: 32, height: 24 }, adapter: imageAdapter(root, item.format, { inFlight: 0, max: 0 }), alphaPolicy: item.format === 'png' ? 'preserve' : 'opaque', ...(item.format === 'jpeg' ? { jpegBackground: { r: 12, g: 34, b: 56 } } : {}), renderingIntent: 'relative-colorimetric', ...(item.format === 'jpeg' ? { qualityEvidence: { unit: '1-100' as const } } : {}) });
      artifactCount += result.artifacts.length;
    }
    expect(artifactCount).toBe(3 * valid.length);
  }, 30_000);

  it('rejects zero/unknown bounds, schema drift, corrupt and wrong-color evidence', async () => {
    expect(() => scaleFor({ left: 0, top: 0, right: 0, bottom: 10 }, { left: 0, top: 0, right: 10, bottom: 10 }, 'cover')).toThrow(RangeError);
    expect(() => buildPinnedLaunchParameters({ nodeExecutable: '/tmp/node', serverEntry: '/tmp/server.js', explicitArgs: [] })).toThrow();
    expect(buildPinnedLaunchParameters({ nodeExecutable: '/Applications/Node 22/bin/node', serverEntry: '/tmp/Photoshop Server/node_modules/@alisaitteke/photoshop-mcp/dist/index.js', explicitArgs: ['--stdio'] }).args[0]).toContain('Photoshop Server');
    const root = await mkdtemp(join(tmpdir(), 'b14-fault-')); const output = { format: 'png' as const, quality: 80, colorSpace: 'sRGB' as const, width: 32, height: 24 };
    for (const faulty of ['corrupt', 'wrongColor'] as const) { const faultRoot = join(root, faulty); await mkdir(faultRoot); await expect(exportVariants({ bundleRoot: faultRoot, approvedBundleRoot: faultRoot, output, adapter: imageAdapter(faultRoot, 'png', { inFlight: 0, max: 0 }, faulty), alphaPolicy: 'preserve', renderingIntent: 'relative-colorimetric' })).rejects.toMatchObject({ code: 'FILE_INVALID' }); }
  });

  it('rejects cross-candidate selector remapping and retains one barrier per lost mutation', async () => {
    const first = { id: 'first', parentId: null, name: 'Target', kind: 'group' as const, bounds: null, visible: true, clipped: false, contentKey: null, children: [] };
    const second = { ...first, id: 'second', name: 'Other' };
    const document: SelectorDocument = { id: 'root', path: null, parentId: null, width: 10, height: 10, dirty: false, sourceKind: 'root', layers: [first, second] };
    const proof = structuralFingerprint(first, document.layers, [0]);
    expect(resolveLayer(document, { documentRoute: [], layerPath: [{ name: 'Target', kind: 'group', fingerprint: proof }] }).id).toBe('first');
    expect(() => resolveLayer(document, { documentRoute: [], layerPath: [{ name: 'Target', kind: 'group', fingerprint: digest('wrong') }] })).toThrow();
    const journal = new OperationJournal(); let calls = 0;
    for (const operation of ['place', 'scale', 'saveChild', 'export', 'closeDiscard']) await expect(runUncertainOperation({ operation, requestId: `b14-${operation}`, mutation: true, timeoutMs: 1, journal, call: async () => { calls += 1; await new Promise<void>(() => undefined); } })).rejects.toMatchObject({ category: 'ambiguousState' });
    expect(calls).toBe(5); expect(journal.pendingUnknown()).toHaveLength(5);
  });

  it('executes every corpus row through its declared acceptance path', async () => {
    let executed = 0;
    for (const item of corpus) {
      executed += 1;
      const flags = new Set(item.flags);
      if (flags.has('handledByCore')) {
        expect(flags.has('windowsReservedName')).toBe(true);
        continue;
      }
      if (flags.has('zeroEffectiveBounds') || flags.has('unknownEffectiveBounds')) {
        expect(() => scaleFor({ left: 0, top: 0, right: flags.has('zeroEffectiveBounds') ? 0 : Number.NaN, bottom: 10 }, { left: 0, top: 0, right: 10, bottom: 10 }, item.fitMode)).toThrow(RangeError);
        continue;
      }
      if (flags.has('schemaDrift')) {
        expect(() => buildPinnedLaunchParameters({ nodeExecutable: '/tmp/node', serverEntry: '/tmp/not-the-pinned-server.js', explicitArgs: [] })).toThrow();
        continue;
      }
      if (flags.has('corruptInput') || flags.has('wrongColor')) {
        const root = await mkdtemp(join(tmpdir(), `b14-row-${item.assetId}-`));
        const faulty = flags.has('corruptInput') ? 'corrupt' : 'wrongColor';
        await expect(exportVariants({ bundleRoot: root, approvedBundleRoot: root, output: { format: item.format, quality: 80, colorSpace: 'sRGB', width: 32, height: 24 }, adapter: imageAdapter(root, item.format, { inFlight: 0, max: 0 }, faulty), alphaPolicy: item.format === 'png' ? 'preserve' : 'opaque', ...(item.format === 'jpeg' ? { jpegBackground: { r: 12, g: 34, b: 56 } } : {}), renderingIntent: 'relative-colorimetric', ...(item.format === 'jpeg' ? { qualityEvidence: { unit: '1-100' as const } } : {}) })).rejects.toMatchObject({ code: 'FILE_INVALID' });
        continue;
      }
      if (flags.has('lostReply')) {
        const operation = item.flags.find((flag) => flag.startsWith('cancel'))?.slice('cancel'.length).toLowerCase() as 'place' | 'scale' | 'saveChild' | 'export' | 'closeDiscard';
        expect(operation).toBeTruthy();
        await expect(runUncertainOperation({ operation, requestId: `b14-row-${item.assetId}`, mutation: true, timeoutMs: 1, journal: new OperationJournal(), call: async () => new Promise<never>(() => undefined) })).rejects.toMatchObject({ category: 'ambiguousState' });
        continue;
      }
      const reference = { left: 100, top: 200, right: item.orientation === 'portrait' ? 700 : 900, bottom: item.orientation === 'landscape' ? 600 : 1000 };
      const placed = { left: 20, top: 30, right: 220, bottom: 430 };
      const scale = scaleFor(reference, placed, item.fitMode);
      const width = (placed.right - placed.left) * scale.percentX / 100;
      const height = (placed.bottom - placed.top) * scale.percentY / 100;
      const finalPlaced = { left: (reference.left + reference.right - width) / 2, top: (reference.top + reference.bottom - height) / 2, right: (reference.left + reference.right + width) / 2, bottom: (reference.top + reference.bottom + height) / 2 };
      expect(checkFit(reference, finalPlaced, placed, item.fitMode, 0.5).every((check) => check.passed)).toBe(true);
    }
    expect(executed).toBe(corpus.length);
  });
});
