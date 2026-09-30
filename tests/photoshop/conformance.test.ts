import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, win32 } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { buildPinnedLaunchParameters, McpClient } from '../../packages/photoshop/src/mcp-client.js';
import { OperationJournal, runUncertainOperation } from '../../packages/photoshop/src/recovery.js';
import { exportVariants, type ExportAdapter } from '../../packages/photoshop/src/export.js';
import { placeAndFit, type PlacementAdapter, type PlacementResult, type TranslationCommand } from '../../packages/photoshop/src/placement.js';
import { ensureClipping, propagateSentinelByIdentity } from '../../packages/photoshop/src/qualification.js';
import { resolveLayer, structuralFingerprint } from '../../packages/photoshop/src/selectors.js';
import { createWorkingCopy, sha256 } from '../../packages/photoshop/src/working-copy.js';
import { buildToolMap } from '../../packages/photoshop/src/tool-map.js';
import type { FitMode, OperationKind, Rect } from '../../packages/photoshop/src/types.js';
import { FakeSession } from './fake-session.js';
import { duplicateSiblingScene, sceneFixture } from './fixtures/scenes.js';

type Row = { assetId: string; fitMode: FitMode; orientation: 'portrait' | 'landscape' | 'square'; format: 'jpeg' | 'png'; source: { width: number; height: number }; flags: string[] };
const corpus = JSON.parse(await readFile(new URL('./fixtures/conformance-cases.json', import.meta.url), 'utf8')) as Row[];
const seed = 'b14-corpus-v2';
const faults = new Set(['handledByCore', 'corruptInput', 'wrongColor', 'schemaDrift', 'zeroEffectiveBounds', 'unknownEffectiveBounds', 'lostReply']);
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const selector = (name: string) => ({ documentRoute: [], layerPath: [{ name, kind: name === 'Reference' ? 'pixel' as const : 'smartObject' as const, fingerprint: name }] });

function reference(row: Row): Rect {
  const size = row.orientation === 'portrait' ? { width: 600, height: 800 } : row.orientation === 'landscape' ? { width: 800, height: 400 } : { width: 600, height: 600 };
  return { left: 100, top: 200, right: 100 + size.width, bottom: 200 + size.height };
}

async function assertConnected(row: Row, connection?: ConnectedScene): Promise<void> {
  if (!connection || !connection.session || !connection.placement || !connection.features) throw new Error('scene is not ready for export');
  const scene = connection.session.readScene();
  if (scene.placed.contentKey !== connection.input || JSON.stringify(scene.placed.bounds) !== JSON.stringify(connection.placement.finalPlaced) || !connection.placement.checks.every((check) => check.passed)) throw new Error('scene is not ready for export');
  if (row.flags.includes('vectorMaskHole') && connection.features.vectorHole !== true) throw new Error('scene is not ready for export');
  if (row.flags.includes('transparentInput') && connection.features.transparent !== true) throw new Error('scene is not ready for export');
  if (row.flags.some((flag) => ['sharedObject', 'independentObjects', 'sharedAndIndependent'].includes(flag))) {
    const groups = connection.features.identities;
    if (!groups || Object.values(groups).flat().length !== 3 || connection.features.writes?.length !== Object.keys(groups).length) throw new Error('scene is not ready for export');
  }
  if (row.flags.includes('linkedDependencies')) {
    const linked = connection.features.linked;
    if (!linked || (await readFile(linked.parentCopy, 'utf8')) !== `link:${linked.dependencyCopy}` || (await sha256(linked.dependencyCopy)) !== linked.digest) throw new Error('scene is not ready for export');
  }
}

async function connectedPixels(row: Row, connection: ConnectedScene, variantId: '1' | '2' | '3'): Promise<Uint8Array> {
  await assertConnected(row, connection);
  const scene = connection.session.readScene();
  const visible = scene.layers.filter((layer) => /^[123] картинка$/.test(layer.name) && layer.visible);
  if (visible.length !== 1 || visible[0]!.name !== `${variantId} картинка`) throw new Error('scene is not ready for export');
  const identity = Object.entries(connection.features.identities ?? {}).find(([, targets]) => targets.includes(variantId === '1' ? 'one' : variantId === '2' ? 'two' : 'three'))?.[0] ?? variantId;
  const color = Buffer.from(digest(`${scene.placed.contentKey}:${connection.features.linked?.digest ?? ''}:${identity}:${variantId}`), 'hex');
  const pixels = Buffer.alloc(32 * 24 * 4);
  const ref = reference(row); const placed = scene.placed.bounds!;
  for (let y = 0; y < 24; y++) for (let x = 0; x < 32; x++) {
    const index = (y * 32 + x) * 4;
    const px = ref.left + (x + 0.5) * (ref.right - ref.left) / 32;
    const py = ref.top + (y + 0.5) * (ref.bottom - ref.top) / 24;
    const inside = px >= placed.left && px <= placed.right && py >= placed.top && py <= placed.bottom && (row.format === 'png' || (x >= 8 && x < 24 && y >= 6 && y < 18));
    const hole = connection.features.vectorHole && x >= 12 && x < 20 && y >= 8 && y < 16;
    pixels[index] = inside && !hole ? color[0]! : 12;
    pixels[index + 1] = inside && !hole ? color[1]! : 34;
    pixels[index + 2] = inside && !hole ? color[2]! : 56;
    pixels[index + 3] = inside && !hole ? connection.features.transparent ? 204 : 255 : row.format === 'png' ? 0 : 255;
  }
  return pixels;
}

function exporter(row: Row, counters: { active: number; maximum: number }, faulty?: 'corrupt' | 'wrongColor', connection?: ConnectedScene): ExportAdapter {
  const format = row.format;
  let visible: '1' | '2' | '3' = '1';
  const measure = async (action: () => Promise<void>) => { counters.active++; counters.maximum = Math.max(counters.maximum, counters.active); try { await action(); } finally { counters.active--; } };
  return {
    restoreQualifiedState: async () => ({ acknowledged: true }),
    hideVariant: async () => ({ acknowledged: true }),
    showVariant: async (variantId) => { visible = variantId; if (connection) await connection.session.execute('setVisibility', connection.placement.documentId, null, () => connection.session.setVisibleVariant(variantId)); return { acknowledged: true }; },
    readVisibility: async () => ({ acknowledged: true, ancestorVisible: true, visibleVariantIds: connection ? connection.session.readScene().layers.filter((layer) => /^[123] картинка$/.test(layer.name) && layer.visible).map((layer) => layer.name[0]!) : [visible] }),
    prepareExport: async () => ({ acknowledged: true, disposable: true, documentId: 'export-copy', convertedPixels: true, renderingIntent: 'relative-colorimetric', mode: 'RGB', bitDepth: 8, embeddedProfile: 'sRGB', flattened: format === 'jpeg', alpha: format === 'png' ? 'preserve' : 'opaque' }),
    exportVariant: async ({ variantId, destination }) => {
      await measure(async () => {
        if (faulty === 'corrupt') { await writeFile(destination, 'corrupt input rendered as invalid output'); return; }
        const image = connection ? sharp(await connectedPixels(row, connection, variantId), { raw: { width: 32, height: 24, channels: 4 } }) : sharp({ create: { width: 32, height: 24, channels: 4, background: { r: Number(variantId) * 60, g: 120, b: 200, alpha: format === 'png' ? 0.8 : 0 } } });
        const output = format === 'png' ? image.png() : image.flatten({ background: { r: 12, g: 34, b: 56 } }).jpeg({ quality: 100 });
        if (faulty !== 'wrongColor') output.withMetadata({ icc: 'srgb' });
        await output.toFile(destination);
      });
      return { acknowledged: true, path: destination };
    },
    cleanupDisposable: async () => ({ acknowledged: true }),
  };
}

async function exportsFor(row: Row, root: string, counters: { active: number; maximum: number }, faulty?: 'corrupt' | 'wrongColor', connection?: ConnectedScene) {
  if (!faulty) await assertConnected(row, connection);
  return exportVariants({ bundleRoot: root, approvedBundleRoot: root, output: { format: row.format, quality: 100, colorSpace: 'sRGB', width: 32, height: 24 }, adapter: exporter(row, counters, faulty, connection), alphaPolicy: row.format === 'png' ? 'preserve' : 'opaque', ...(row.format === 'jpeg' ? { jpegBackground: { r: 12, g: 34, b: 56 }, qualityEvidence: { unit: '1-100' as const } } : {}), renderingIntent: 'relative-colorimetric' });
}

async function fitted(row: Row, session: FakeSession, invalid?: 'zero' | 'unknown') {
  const opened = await session.openFreshCopy(row.assetId);
  const scene = session.readScene();
  const targetId = scene.placed.id;
  const referenceId = scene.reference.id;
  const ref = reference(row);
  // Source metadata is intentionally different from measured post-place bounds.
  let bounds: Rect = { left: 20, top: 30, right: 20 + row.source.width / 10, bottom: 30 + row.source.height / 10 };
  const adapter: PlacementAdapter = {
    capabilities: async () => ({ liveQualified: true, supportedFitModes: ['cover', 'contain', 'stretch'], independentAxisScale: true, scaleSemantics: 'independent-percent', translationSemantics: 'absolute', translationRoundingPx: 0 }),
    resolve: async (value) => ({ documentId: opened.rootId, layerId: value.layerPath[0]?.name === 'Reference' ? referenceId : targetId, kind: value.layerPath[0]?.name === 'Reference' ? 'pixel' : 'smartObject' }),
    existingLayerIds: async () => [referenceId, targetId],
    readEffectiveBounds: async (identity) => identity.layerId === referenceId ? invalid === 'zero' ? { ...ref, right: ref.left } : invalid === 'unknown' ? null : ref : bounds,
    select: async (identity) => ({ acknowledged: true, ...identity }),
    replaceContents: async (identity, input) => { await session.place(opened.rootId, targetId, input); return { acknowledged: true, ...identity, bounds }; },
    scale: async (_identity, plan) => { await session.execute('scale', opened.rootId, targetId, () => { const width = (bounds.right - bounds.left) * plan.percentX / 100; const height = (bounds.bottom - bounds.top) * plan.percentY / 100; const cx = (bounds.left + bounds.right) / 2; const cy = (bounds.top + bounds.bottom) / 2; bounds = { left: cx - width / 2, top: cy - height / 2, right: cx + width / 2, bottom: cy + height / 2 }; session.setLayerBounds(targetId, bounds); }); return { acknowledged: true }; },
    translate: async (_identity, command: TranslationCommand) => { await session.execute('translate', opened.rootId, targetId, () => { const center = command.payload as { x: number; y: number }; const dx = center.x - (bounds.left + bounds.right) / 2; const dy = center.y - (bounds.top + bounds.bottom) / 2; bounds = { left: bounds.left + dx, top: bounds.top + dy, right: bounds.right + dx, bottom: bounds.bottom + dy }; session.setLayerBounds(targetId, bounds); }); return { acknowledged: true }; },
  };
  const input = `/approved/${row.assetId}.png`;
  return placeAndFit({ adapter, reference: selector('Reference'), target: selector('Placed'), input, approvedInputs: [input], sourceMetadata: row.source, fitMode: row.fitMode });
}

async function linkedClosure(row: Row, skipMutation = false): Promise<{ parentCopy: string; dependencyCopy: string; digest: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), `b14-link-${row.assetId}-`)));
  const master = join(root, 'master.psd'); const dependency = join(root, 'зависимость.psb');
  await writeFile(master, `link:${dependency}`); await writeFile(dependency, 'dependency-original');
  const masterHash = await sha256(master); const dependencyHash = await sha256(dependency);
  const result = await createWorkingCopy({ masterPath: master, trustedRoot: root, attemptRoot: join(root, 'attempt'), expectedHashes: { [master]: masterHash, [dependency]: dependencyHash }, operation: {
    readLinks: async (path) => {
      const bytes = await readFile(path, 'utf8');
      return bytes.startsWith('link:') ? [{ path: bytes.slice(5), sourceKind: 'linked' as const, expectedSha256: dependencyHash }] : [];
    },
    relink: async (parent, originalSource, jobOwnedSource) => {
      if (!skipMutation) await writeFile(parent, `link:${jobOwnedSource}`);
      return { acknowledged: true, parentPath: parent, originalSource, jobOwnedSource };
    },
  } });
  expect(result.closure).toHaveLength(2);
  expect(result.closure.every((entry) => entry.copyPath.startsWith(result.attemptRoot))).toBe(true);
  expect(await sha256(master)).toBe(masterHash); expect(await sha256(dependency)).toBe(dependencyHash);
  expect(result.originalHashes.get(await realpath(dependency))).toBe(dependencyHash);
  const canonicalDependency = await realpath(dependency);
  const dependencyCopy = result.closure.find((entry) => entry.originalPath === canonicalDependency)!.copyPath;
  expect(await readFile(result.masterPath, 'utf8')).toBe(`link:${dependencyCopy}`);
  return { parentCopy: result.masterPath, dependencyCopy, digest: await sha256(dependencyCopy) };
}

type FeatureState = { identities?: Record<string, string[]>; writes?: string[]; linked?: { parentCopy: string; dependencyCopy: string; digest: string }; vectorHole?: boolean; transparent?: boolean };
type ConnectedScene = { session: FakeSession; placement: PlacementResult; features: FeatureState; input: string };

async function featureProof(row: Row, root: string): Promise<FeatureState> {
  const flags = new Set(row.flags);
  const result: FeatureState = {};
  if (flags.has('sharedObject') || flags.has('independentObjects') || flags.has('sharedAndIndependent')) {
    const ids: Record<string, string> = flags.has('sharedObject') ? { one: 'same', two: 'same', three: 'same' } : flags.has('independentObjects') ? { one: 'one', two: 'two', three: 'three' } : { one: 'same', two: 'same', three: 'other' };
    const written: string[] = [];
    const proof = await propagateSentinelByIdentity({ getContentIdentity: async (target) => ids[target]!, writeContent: async (identity) => { written.push(identity); return { acknowledged: true }; } }, ['one', 'two', 'three'], join(root, 'sentinel.png'));
    expect(proof.routes).toEqual(['one', 'two', 'three']);
    expect(written).toEqual([...new Set(Object.values(ids))]);
    expect(proof.writes).toHaveLength(new Set(Object.values(ids)).size);
    result.identities = proof.equivalentTargets;
    result.writes = written;
  }
  if (flags.has('linkedDependencies')) result.linked = await linkedClosure(row);
  if (flags.has('duplicateLayerNames')) {
    const document = duplicateSiblingScene();
    const duplicate = document.layers.at(-1)!;
    duplicate.mask = { discriminator: row.assetId };
    const first = document.layers.find((layer) => layer.name === duplicate.name)!;
    const firstIndex = document.layers.indexOf(first);
    const resolved = resolveLayer(document, { documentRoute: [], layerPath: [{ name: first.name, kind: first.kind, fingerprint: structuralFingerprint(first, document.layers, [firstIndex]) }] });
    expect(resolved.id).toBe(first.id);
  }
  if (flags.has('vectorMaskHole')) {
    const relation = { inputId: 'input', referenceId: 'reference', parentId: 'parent', inputIndex: 0, referenceIndex: 1, clipped: true, baseId: 'reference', kind: 'shape' as const, mask: { holes: [[10, 10], [20, 20]] }, effects: { shadow: true }, maskSemantics: 'vector' as const, layerCount: 2 };
    const clipping = await ensureClipping({ inspectClipping: async () => relation }, 'input', 'reference');
    expect(clipping).toMatchObject({ clipped: true, adjacentToReference: true });
    result.vectorHole = clipping.clipped && clipping.adjacentToReference;
  }
  if (flags.has('transparentInput')) {
    const input = join(root, 'transparent-source.png');
    await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } }).png().toFile(input);
    expect((await sharp(input).metadata()).hasAlpha).toBe(true);
    result.transparent = true;
  }
  if (flags.has('cyrillicFilename')) {
    const input = join(root, 'вход с пробелом.png'); await writeFile(input, 'small-source-name-proof');
    expect(await readFile(input, 'utf8')).toBe('small-source-name-proof');
    expect(row.assetId).not.toBe(basename(input));
  }
  return result;
}

describe('B14 executable Photoshop fake corpus', () => {
  it('rejects export from an unplaced scene rather than painting standalone variant fixtures', async () => {
    const row = corpus[0]!;
    const root = await mkdtemp(join(tmpdir(), 'b14-unplaced-'));
    const session = new FakeSession(sceneFixture());
    await session.openFreshCopy(row.assetId);
    await expect((exportsFor as (...args: unknown[]) => Promise<unknown>)(row, root, { active: 0, maximum: 0 }, undefined, session)).rejects.toThrow('scene is not ready for export');
  });

  it('rejects a relink acknowledgement when the copied parent still points at the original dependency', async () => {
    const row = corpus.find((item) => item.flags.includes('linkedDependencies'))!;
    await expect((linkedClosure as (...args: unknown[]) => Promise<unknown>)(row, true)).rejects.toMatchObject({ code: 'LINKED_SOURCE_UNISOLATED' });
  });

  it('makes export pixels depend on measured placement for the same source', async () => {
    const row = corpus.find((item) => item.assetId === 'asset-cover-portrait-png')!;
    const render = async (fitMode: FitMode) => {
      const current = { ...row, fitMode };
      const root = await mkdtemp(join(tmpdir(), 'b14-placement-pixels-'));
      const session = new FakeSession(sceneFixture());
      const placement = await fitted(current, session);
      const features = await featureProof(current, root);
      const result = await exportsFor(current, root, { active: 0, maximum: 0 }, undefined, { session, placement, features, input: `/approved/${row.assetId}.png` });
      const bytes = await readFile(join(root, result.artifacts[0]!.path));
      await session.closeOwned();
      return digest(bytes);
    };
    expect(await render('cover')).not.toBe(await render('contain'));
  });

  it('rejects export when an isolated linked dependency changes after qualification', async () => {
    const row = corpus.find((item) => item.flags.includes('linkedDependencies'))!;
    const root = await mkdtemp(join(tmpdir(), 'b14-linked-tamper-'));
    const session = new FakeSession(sceneFixture());
    const placement = await fitted(row, session);
    const features = await featureProof(row, root);
    await writeFile(features.linked!.dependencyCopy, 'tampered job copy');
    await expect(exportsFor(row, root, { active: 0, maximum: 0 }, undefined, { session, placement, features, input: `/approved/${row.assetId}.png` })).rejects.toThrow('scene is not ready for export');
  });

  it('has a complete, unique 18-row valid matrix and named fault rows', () => {
    const valid = corpus.filter((row) => !row.flags.some((flag) => faults.has(flag)));
    const knownFlags = new Set(['nonOriginReference', 'transparentInput', 'vectorMaskHole', 'cyrillicFilename', 'spaces', 'sharedObject', 'independentObjects', 'duplicateLayerNames', 'linkedDependencies', 'sharedAndIndependent', 'windowsReservedName', 'caseOnlyCollision', 'handledByCore', 'corruptInput', 'wrongColor', 'schemaDrift', 'zeroEffectiveBounds', 'unknownEffectiveBounds', 'lostReply', 'cancelPlace', 'cancelScale', 'cancelSave', 'cancelExport', 'cancelClose']);
    expect(corpus.flatMap((row) => row.flags).filter((flag) => !knownFlags.has(flag))).toEqual([]);
    expect(new Set(corpus.map((row) => row.assetId)).size).toBe(corpus.length);
    expect(valid).toHaveLength(18);
    expect(new Set(valid.map((row) => `${row.fitMode}:${row.orientation}:${row.format}`)).size).toBe(18);
    expect(new Set(valid.map((row) => `${row.source.width}x${row.source.height}`))).toEqual(new Set(['500x500', '5000x5000', '12000x8000', '800x1200']));
    expect(seed).toBe('b14-corpus-v2');
  });

  it('runs each valid row through measured placement, its own feature proof, three decoded exports and cleanup', async () => {
    let artifacts = 0;
    const valid = corpus.filter((row) => !row.flags.some((flag) => faults.has(flag)));
    for (const row of valid) {
      const root = await mkdtemp(join(tmpdir(), `b14-${row.assetId}-`));
      const session = new FakeSession(sceneFixture());
      const placed = await fitted(row, session);
      expect(placed.checks.every((check) => check.passed), row.assetId).toBe(true);
      expect(placed.evidence.some((entry) => entry.operation === 'scale')).toBe(true);
      const features = await featureProof(row, root);
      const counters = { active: 0, maximum: 0 };
      const rendered = await exportsFor(row, root, counters, undefined, { session, placement: placed, features, input: `/approved/${row.assetId}.png` });
      expect(rendered.artifacts).toHaveLength(3);
      for (const artifact of rendered.artifacts) {
        const bytes = await readFile(join(root, artifact.path));
        expect(digest(bytes)).toBe(artifact.sha256);
        expect((await sharp(bytes).metadata()).format).toBe(row.format === 'jpeg' ? 'jpeg' : 'png');
        if (row.flags.includes('vectorMaskHole') && row.format === 'png') {
          const raw = await sharp(bytes).ensureAlpha().raw().toBuffer();
          expect(raw[(12 * 32 + 16) * 4 + 3]).toBe(0);
          expect(raw[(12 * 32 + 10) * 4 + 3]).toBe(255);
        }
        expect(artifact.path).not.toContain(row.assetId);
      }
      artifacts += rendered.artifacts.length;
      await session.closeOwned();
      expect(session.maximumInFlight).toBe(1);
      expect(counters.maximum).toBe(1);
      expect(session.documents.filter((document) => document.id.startsWith('doc-'))).toHaveLength(0);
      expect(session.documents).toHaveLength(1); // unrelated user document
    }
    expect(artifacts).toBe(3 * valid.length);
  }, 30_000);

  it('executes every fault row at its own production boundary with typed failure or explicit core ownership', async () => {
    const invalid = corpus.filter((row) => row.flags.some((flag) => faults.has(flag)));
    const visited: string[] = [];
    for (const row of invalid) {
      visited.push(row.assetId);
      const flags = new Set(row.flags);
      if (flags.has('handledByCore')) {
        const names = ['CON.png', 'con.png'];
        expect(win32.basename(win32.join('C:\\NE PSD\\шаблоны', names[0]!))).toBe(names[0]);
        expect(names[0]!.toLowerCase()).toBe(names[1]);
        const launch = buildPinnedLaunchParameters({ nodeExecutable: 'C:\\Node 22\\node.exe', serverEntry: 'C:\\NE PSD\\server\\node_modules\\@alisaitteke\\photoshop-mcp\\dist\\index.js', explicitArgs: ['--stdio'] });
        expect(launch.args[0]).toContain('NE PSD');
      } else if (flags.has('zeroEffectiveBounds') || flags.has('unknownEffectiveBounds')) {
        const session = new FakeSession(sceneFixture());
        await expect(fitted(row, session, flags.has('zeroEffectiveBounds') ? 'zero' : 'unknown')).rejects.toMatchObject({ code: 'EFFECTIVE_BOUNDS_UNKNOWN' });
        await session.closeOwned();
        expect(session.documents).toHaveLength(1);
      } else if (flags.has('schemaDrift')) {
        const tools = [{ name: 'qualified-scale', inputSchema: { type: 'object', properties: { percent: { type: 'number' } }, required: ['percent'] }, outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } }];
        const transport = { listTools: async () => ({ tools }), callTool: async () => ({ ok: true }) };
        const client = new McpClient({ transport, toolMap: buildToolMap(tools), schemaDigest: '0'.repeat(64) });
        await expect(client.listSchemaDigest()).rejects.toMatchObject({ code: 'SCHEMA_DIGEST_MISMATCH' });
      } else if (flags.has('corruptInput') || flags.has('wrongColor')) {
        const root = await mkdtemp(join(tmpdir(), `b14-fault-${row.assetId}-`));
        const counters = { active: 0, maximum: 0 };
        if (flags.has('corruptInput')) {
          const source = join(root, 'corrupt-source.png'); await writeFile(source, 'not image bytes');
          await expect(sharp(source).metadata()).rejects.toThrow();
        }
        await expect(exportsFor(row, root, counters, flags.has('corruptInput') ? 'corrupt' : 'wrongColor')).rejects.toMatchObject({ code: 'FILE_INVALID' });
        expect(counters.maximum).toBe(1);
      } else if (flags.has('lostReply')) {
        const operation = ({ cancelPlace: 'place', cancelScale: 'scale', cancelSave: 'saveChild', cancelExport: 'export', cancelClose: 'closeDiscard' } as const)[row.flags.find((flag) => flag.startsWith('cancel')) as keyof { cancelPlace: 'place'; cancelScale: 'scale'; cancelSave: 'saveChild'; cancelExport: 'export'; cancelClose: 'closeDiscard' }];
        expect(operation).toBeTruthy();
        const session = new FakeSession(sceneFixture());
        const journal = new OperationJournal();
        session.applyThenLoseReply(operation as OperationKind);
        let effects = 0;
        await expect(runUncertainOperation({ operation, requestId: row.assetId, mutation: true, timeoutMs: 1000, journal, call: () => session.execute(operation, session.documents[0]!.id, null, () => { effects++; }) })).rejects.toMatchObject({ category: 'ambiguousState', retryable: false });
        expect(effects).toBe(1);
        expect(session.calls.filter((call) => call.operation === operation)).toHaveLength(1);
        expect(session.maximumInFlight).toBe(1);
        expect(journal.pendingUnknown()).toHaveLength(1);
        expect(session.documents.length).toBeGreaterThan(1); // retained until reconciliation
        const cancelled = new AbortController(); cancelled.abort();
        const before = session.calls.length;
        await expect(runUncertainOperation({ operation, requestId: `${row.assetId}-cancel-before-dispatch`, mutation: true, timeoutMs: 1000, journal: new OperationJournal(), signal: cancelled.signal, call: () => session.execute(operation, session.documents[0]!.id, null) })).rejects.toMatchObject({ category: 'cancelled' });
        expect(session.calls).toHaveLength(before);
      } else throw new Error(`unhandled corpus row ${row.assetId}`);
    }
    expect(visited).toEqual(invalid.map((row) => row.assetId));
  }, 30_000);
});
