import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { InspectionReportSchema, QualificationResultSchema, type ConfigurationProposal, type InspectionReport } from '@ne-psd/contracts';
import { propagateSentinelByIdentity, qualify, withinCanonicalRoot, type QualificationAdapter, type QualificationObservation, type SelectorProof } from '../../packages/photoshop/src/qualification.js';
import { placeAndFit, type PlacementAdapter } from '../../packages/photoshop/src/placement.js';
import { SessionLock } from '../../packages/photoshop/src/session-lock.js';

const caps = { backendId: 'alisaitteke' as const, supportedFitModes: ['cover', 'contain', 'stretch'] as const, toolSchemaSha256: '9c9073a076825a775ae8ca3a8fd31a4cd083762112fc752d2a6ffade64e55d35', evidencePaths: ['assets/capabilities.json'], version: 'fake', sourceCommit: 'fake', platform: 'darwin' as const, photoshopVersion: 'fake' };
const inspection = (): InspectionReport => InspectionReportSchema.parse({ schemaVersion: 1, inspectionId: 'live-b10', evidenceStatus: 'liveObserved', template: { rootId: 'master', relativePath: 'template.psd', sha256: 'fb05f9b91299f345f77e8a71cb4155b21d95e0365fc62a248212e6912389f55b' }, capabilities: caps, documents: [{ documentKey: 'root', parentKey: null, viaLayer: null, sourceKind: 'root', source: { rootId: 'master', relativePath: 'template.psd', sha256: caps.toolSchemaSha256 }, width: 1000, height: 800, colorMode: 'RGB', bitDepth: 8 }], candidates: [
  { candidateId: 'target', documentKey: 'root', selector: { documentRoute: [], layerPath: [{ name: 'Target', kind: 'smartObject', fingerprint: 'target' }] }, bounds: { left: 0, top: 0, right: 10, bottom: 10 }, visible: true, clipped: false, belowCandidateId: null, roleHints: ['target'] },
  { candidateId: 'reference', documentKey: 'root', selector: { documentRoute: [], layerPath: [{ name: 'Reference', kind: 'pixel', fingerprint: 'reference' }] }, bounds: { left: 0, top: 0, right: 10, bottom: 10 }, visible: true, clipped: false, belowCandidateId: null, roleHints: ['reference'] },
  ...(['1', '2', '3'] as const).map((id) => ({ candidateId: `variant-${id}`, documentKey: 'root', selector: { documentRoute: [], layerPath: [{ name: `Variant ${id}`, kind: 'group' as const, fingerprint: `variant-${id}` }] }, bounds: null, visible: id === '1', clipped: false, belowCandidateId: null, roleHints: ['variant' as const] })),
], observedVariantStates: [{ candidateId: 'variant-1', visible: true }, { candidateId: 'variant-2', visible: false }, { candidateId: 'variant-3', visible: false }], unresolvedLinks: [], evidencePaths: ['assets/inspection.json', 'assets/capabilities.json'] });
const proposal = (): ConfigurationProposal => ({ schemaVersion: 1, inspectionId: 'live-b10', status: 'proposed', targets: [{ targetCandidateId: 'target', referenceCandidateId: 'reference', inputCandidateId: null }], variants: [{ id: '1', groupCandidateId: 'variant-1' }, { id: '2', groupCandidateId: 'variant-2' }, { id: '3', groupCandidateId: 'variant-3' }], fitMode: 'cover', output: { format: 'png', quality: 90, colorSpace: 'sRGB', width: 32, height: 32 }, missingFields: [], facts: [{ claim: 'live fixture', evidenceRefs: ['assets/inspection.json'] }], explanation: 'fake evidence' });
const selectorProof = (preparedSha256 = ''): SelectorProof => { const i = inspection(); const by = new Map(i.candidates.map((candidate) => [candidate.candidateId, candidate])); return { preparedSha256, targets: [{ targetCandidateId: 'target', referenceCandidateId: 'reference', inputCandidateId: null, target: by.get('target')!.selector, reference: by.get('reference')!.selector, input: null }], variants: (['1', '2', '3'] as const).map((id) => ({ candidateId: `variant-${id}`, id, group: by.get(`variant-${id}`)!.selector })) }; };
const selectorId = (value: unknown): string => JSON.stringify(value);

async function realSentinel(path: string, variant: string): Promise<void> { const pixels = Buffer.alloc(32 * 32 * 4); const put = (x: number, y: number, c: [number, number, number, number]) => pixels.set(c, (y * 32 + x) * 4); put(0, 0, [240, 32, 32, 255]); put(31, 0, [32, 220, 64, 255]); put(0, 31, [48, 96, 240, 255]); put(31, 31, [240, 200, 32, 255]); for (let n = 8; n < 24; n += 1) { put(15, n, [255, 255, 255, 255]); put(16, n, [255, 255, 255, 255]); put(n, 15, [255, 255, 255, 255]); put(n, 16, [255, 255, 255, 255]); } put(Number(variant) + 4, 4, [Number(variant) * 50, 20, 100, 255]); await sharp(pixels, { raw: { width: 32, height: 32, channels: 4 } }).png().toFile(path); }
async function badImage(path: string, mode: string): Promise<void> { const pixels = Buffer.alloc(32 * 32 * 4); const put = (x: number, y: number, c: [number, number, number, number]) => pixels.set(c, (y * 32 + x) * 4); const alpha = mode === 'alpha' ? 255 : 0; put(0, 0, [240, 32, 32, 255]); put(31, 0, mode === 'orientation' ? [240, 200, 32, 255] : [32, 220, 64, 255]); put(0, 31, [48, 96, 240, 255]); put(31, 31, [240, 200, 32, 255]); if (mode !== 'coverage') { for (let n = 8; n < 24; n += 1) { put(15, n, [255, 255, 255, 255]); put(n, 15, [255, 255, 255, 255]); } } if (mode === 'alpha') for (let n = 0; n < 32; n += 1) for (let m = 0; m < 32; m += 1) pixels[(n * 32 + m) * 4 + 3] = alpha; await sharp(pixels, { raw: { width: 32, height: 32, channels: 4 } }).png().toFile(path); }

async function setup(overrides: Partial<QualificationAdapter> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'b10-real-evidence-')); const evidence = join(root, 'evidence'); await mkdir(evidence, { recursive: true }); const master = join(root, 'master.psd'); await writeFile(master, 'master-bytes'); const i = inspection(); const p = proposal(); const proof = selectorProof(); let selected: '1' | '2' | '3' = '1'; let writes = 0; let txCleanups = 0; let copyCleanups = 0; const evidenceFile = async (name: string, value: unknown) => { const path = join(evidence, name); await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, JSON.stringify(value)); return name; }; const baselinePath = join(evidence, 'sentinel', 'baseline.png'); await mkdir(join(baselinePath, '..'), { recursive: true }); await realSentinel(baselinePath, '0'); const baselineBytes = await readFile(baselinePath); const baseline = { targetId: 'target', region: { left: 0, top: 0, right: 10, bottom: 10 }, path: 'sentinel/baseline.png', bytes: baselineBytes.byteLength, sha256: createHash('sha256').update(baselineBytes).digest('hex') };
  const adapter: QualificationAdapter = {
    lock: { runExclusive: async (_id, fn) => fn() }, capabilities: async () => caps,
    createWorkingCopy: async ({ masterPath }) => { const path = join(evidence, 'prepared.psd'); await copyFile(masterPath, path); const sha = createHash('sha256').update('master-bytes').digest('hex'); return { path, closure: [{ originalPath: masterPath, sha256: sha }], verifyOriginals: async () => true, cleanup: async () => { copyCleanups += 1; } }; },
    preparedLinks: { readLinks: async (path) => ({ sourceSha256: createHash('sha256').update(await readFile(path)).digest('hex'), complete: true, links: [] }) },
    snapshot: async (label) => ({ label, actual: true }), prepare: async ({ workingTemplatePath }) => { await writeFile(workingTemplatePath, 'prepared-bytes'); return { changed: true }; }, savePreparedCopy: async () => ({ acknowledged: true }), reopenPreparedCopy: async () => ({ acknowledged: true }), resolveSelectors: async () => ({ ...proof, preparedSha256: createHash('sha256').update('prepared-bytes').digest('hex') }),
    verifyGeometry: async () => ({ passed: true, evidencePath: await evidenceFile('checks/geometry.json', { measured: true }) }), verifyLinkage: async () => ({ passed: true, evidencePath: await evidenceFile('checks/linkage.json', { closure: true }) }), verifyClipping: async () => ({ passed: true, evidencePath: await evidenceFile('checks/clipping.json', { exact: true }) }),
    inspectClipping: async (input, reference) => ({ inputId: selectorId(input), referenceId: selectorId(reference), parentId: 'parent', referenceParentId: 'parent', inputIndex: 0, referenceIndex: 1, clipped: true, baseId: selectorId(reference), kind: 'smartObject', mask: { holes: true }, effects: { shadow: true }, outerTransform: { scale: 1 }, maskSemantics: 'alpha', layerCount: 2, uniqueNames: true }),
    getContentIdentity: async () => 'shared-A', writeContent: async () => { writes += 1; return { acknowledged: true }; }, savePropagation: async () => ({ acknowledged: true }), reopenPropagation: async () => ({ acknowledged: true }),
    setVariantVisibility: async (variant) => { selected = variant; return { acknowledged: true }; }, readVariantVisibility: async () => ({ visibleVariantIds: [selected] }), captureSentinelBaseline: async () => ({ records: [baseline] }), verifySentinelCorrespondence: async ({ variantId, outputPath, baseline: expected }) => { const output = await readFile(outputPath); return { targetId: expected.targetId, region: expected.region, baselinePath: expected.path, baselineBytes: expected.bytes, baselineSha256: expected.sha256, outputPath, outputBytes: output.byteLength, outputSha256: createHash('sha256').update(output).digest('hex'), evidencePath: await evidenceFile(`checks/sentinel-${variantId}.json`, { variantId, targetId: expected.targetId, region: expected.region, baselineSha256: expected.sha256, outputSha256: createHash('sha256').update(output).digest('hex') }), passed: true }; }, exporter: async ({ variantId }) => { const path = join(evidence, 'variants', `${variantId}.png`); await mkdir(join(path, '..'), { recursive: true }); await realSentinel(path, variantId); return { path }; }, cleanup: async () => { txCleanups += 1; },
    ...overrides,
  };
  return { root, evidence, master, adapter, inspection: i, proposal: p, proof, counters: () => ({ writes, txCleanups, copyCleanups }) };
}
function request(fixture: Awaited<ReturnType<typeof setup>>) { return { schemaVersion: 1 as const, inspection: fixture.inspection, proposal: fixture.proposal, workingTemplatePath: fixture.master, evidenceDirectory: fixture.evidence }; }
const options = (fixture: Awaited<ReturnType<typeof setup>>) => ({ adapter: fixture.adapter, approvedCapability: true as const, approvedTemplateRoots: [fixture.root], approvedEvidenceRoots: [fixture.root] });

describe('qualification real evidence boundary', () => {
  it('retains measured prepared bytes after scratch cleanup', async () => {
    const fixture = await setup();
    const scratch = join(fixture.evidence, 'scratch');
    fixture.adapter.createWorkingCopy = async ({ masterPath }) => {
      await mkdir(scratch);
      const path = join(scratch, 'template.psd');
      await copyFile(masterPath, path);
      return { path, closure: [{ originalPath: masterPath, sha256: createHash('sha256').update('master-bytes').digest('hex') }],
        verifyOriginals: async () => true, cleanup: async () => rm(scratch, { recursive: true }) };
    };
    const result = await qualify(request(fixture), options(fixture));
    expect(result.status).toBe('qualified');
    expect(result.candidate?.template.relativePath).toBe('prepared/template.psd');
    const retained = await readFile(join(fixture.evidence, result.candidate!.template.relativePath));
    expect(createHash('sha256').update(retained).digest('hex')).toBe(result.candidate?.template.sha256);
    expect(retained.toString()).toBe('prepared-bytes');
    expect((await readFile(fixture.master)).toString()).toBe('master-bytes');
    await expect(readFile(join(scratch, 'template.psd'))).rejects.toThrow();
  });

  it('blocks cancellation while reproving retained selectors before publication', async () => {
    const fixture = await setup();
    const controller = new AbortController();
    let selectorCalls = 0;
    fixture.adapter.resolveSelectors = async ({ workingTemplatePath }) => {
      selectorCalls += 1;
      if (selectorCalls === 2) controller.abort();
      return { ...fixture.proof, preparedSha256: createHash('sha256').update(await readFile(workingTemplatePath)).digest('hex') };
    };
    const result = await qualify(request(fixture), options(fixture), controller.signal);
    expect(result.status).toBe('blocked');
    expect(result.candidate).toBeNull();
    expect(result.errors[0]).toMatchObject({ code: 'CANCELLED', category: 'cancelled' });
    expect(fixture.counters()).toMatchObject({ txCleanups: 1, copyCleanups: 1 });
  });

  it('blocks a stale prepared destination rather than overwriting it', async () => {
    const fixture = await setup();
    await mkdir(join(fixture.evidence, 'prepared'));
    const stale = join(fixture.evidence, 'prepared', 'prepared.psd');
    await writeFile(stale, 'stale');
    const result = await qualify(request(fixture), options(fixture));
    expect(result.status).toBe('blocked');
    expect((await readFile(stale)).toString()).toBe('stale');
  });

  it('blocks a prepared file changed during cleanup', async () => {
    const fixture = await setup();
    fixture.adapter.cleanup = async () => { await writeFile(join(fixture.evidence, 'prepared', 'prepared.psd'), 'tampered'); };
    const result = await qualify(request(fixture), options(fixture));
    expect(result.status).toBe('blocked');
    expect(result.candidate).toBeNull();
  });

  it('blocks linked dependencies without a retained closure proof', async () => {
    const fixture = await setup();
    const original = fixture.adapter.createWorkingCopy;
    const dependency = join(fixture.root, 'dependency.psb');
    await writeFile(dependency, 'dependency');
    fixture.adapter.createWorkingCopy = async (input) => {
      const copy = await original(input);
      return { ...copy, closure: [...copy.closure, { originalPath: dependency, sha256: createHash('sha256').update('dependency').digest('hex') }] };
    };
    fixture.adapter.preparedLinks = { readLinks: async (path) => ({
      sourceSha256: createHash('sha256').update(await readFile(path)).digest('hex'), complete: true,
      links: path.endsWith('prepared.psd') ? [{ sourceKind: 'linked', path: dependency }] : [],
    }) };
    const result = await qualify(request(fixture), options(fixture));
    expect(result.status).toBe('blocked');
    expect(result.candidate).toBeNull();
  });

  it('retains a relinked prepared dependency closure after scratch cleanup', async () => {
    const fixture = await setup();
    const scratch = join(fixture.evidence, 'scratch');
    const originalDependency = join(fixture.root, 'dependency.psb');
    const scratchDependency = join(scratch, 'dependency.psb');
    await writeFile(originalDependency, 'dependency-bytes');
    fixture.adapter.createWorkingCopy = async ({ masterPath }) => {
      await mkdir(scratch);
      const path = join(scratch, 'template.psd');
      await copyFile(masterPath, path);
      await copyFile(originalDependency, scratchDependency);
      return { path, closure: [
        { originalPath: masterPath, sha256: createHash('sha256').update('master-bytes').digest('hex') },
        { originalPath: originalDependency, sha256: createHash('sha256').update('dependency-bytes').digest('hex') },
      ], verifyOriginals: async () => true, cleanup: async () => rm(scratch, { recursive: true }) };
    };
    fixture.adapter.resolveSelectors = async ({ workingTemplatePath }) => ({ ...fixture.proof,
      preparedSha256: createHash('sha256').update(await readFile(workingTemplatePath)).digest('hex') });
    fixture.adapter.preparedLinks = {
      readLinks: async (path) => {
        const bytes = await readFile(path);
        const value = bytes.toString();
        const links = value === 'prepared-bytes' ? [{ sourceKind: 'linked' as const, path: scratchDependency }]
          : value.startsWith('prepared-linked:') ? [{ sourceKind: 'linked' as const, path: value.slice('prepared-linked:'.length) }] : [];
        return { sourceSha256: createHash('sha256').update(bytes).digest('hex'), complete: true, links };
      },
      relink: async (parent, original, copy) => {
        await writeFile(parent, `prepared-linked:${copy}`);
        return { acknowledged: true, parentPath: parent, originalSource: original, jobOwnedSource: copy };
      },
    };
    const result = await qualify(request(fixture), options(fixture));
    expect(result.status).toBe('qualified');
    expect(result.candidate?.template.relativePath).toBe('prepared/template.psd');
    const retained = join(fixture.evidence, 'prepared/template.psd');
    const linked = (await readFile(retained, 'utf8')).slice('prepared-linked:'.length);
    expect(linked.startsWith(join(await realpath(fixture.evidence), 'prepared'))).toBe(true);
    expect((await readFile(linked)).toString()).toBe('dependency-bytes');
    expect(result.evidencePaths).toContain(linked.slice((await realpath(fixture.evidence)).length + 1));
    expect((await readFile(fixture.master)).toString()).toBe('master-bytes');
    expect((await readFile(originalDependency)).toString()).toBe('dependency-bytes');
    await expect(readFile(scratchDependency)).rejects.toThrow();
  });
  it('keeps canonical root containment case-sensitive', async () => { expect(withinCanonicalRoot('/approved/SAFE', '/approved/safe/asset.psd')).toBe(false); const fixture = await setup(); const upper = join(fixture.root, 'SAFE'); const lower = join(fixture.root, 'safe'); await mkdir(upper); await mkdir(lower).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; }); const a = await stat(upper); const b = await stat(lower); if (a.dev !== b.dev || a.ino !== b.ino) { const source = join(lower, 'asset.psd'); await writeFile(source, 'master-bytes'); const result = await qualify({ ...request(fixture), workingTemplatePath: source }, { ...options(fixture), approvedTemplateRoots: [upper] }); expect(result.status).toBe('blocked'); expect(result.errors[0]).toMatchObject({ code: 'PATH_ESCAPE' }); expect(fixture.counters()).toMatchObject({ txCleanups: 0, copyCleanups: 0 }); } });
  it('qualifies only after decoding three asymmetric PNG variants and preserving the master', async () => { const fixture = await setup(); const result = await qualify(request(fixture), options(fixture)); expect(result.status).toBe('qualified'); expect(result.evidencePaths.filter((path) => path.startsWith('variants/'))).toHaveLength(3); expect(QualificationResultSchema.safeParse(result).success).toBe(true); expect(fixture.counters()).toEqual({ writes: 1, txCleanups: 1, copyCleanups: 1 }); expect(result.candidate).not.toHaveProperty('qualificationId'); });
  it('blocks sentinel qualification without a true pre-mutation baseline and correspondence proof', async () => { const fixture = await setup({ captureSentinelBaseline: undefined, verifySentinelCorrespondence: undefined }); const result = await qualify(request(fixture), options(fixture)); expect(result.status).toBe('blocked'); expect(result.errors[0]).toMatchObject({ code: 'SENTINEL_BASELINE_MISSING' }); });
  it.each(['corrupt', 'duplicate', 'boolean-only', 'orientation', 'alpha', 'coverage'])('blocks %s export evidence', async (mode) => { const fixture = await setup(); if (mode === 'corrupt') fixture.adapter.exporter = async ({ variantId }) => { const path = join(fixture.evidence, 'variants', `${variantId}.png`); await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, 'not an image'); return { path }; }; if (mode === 'duplicate') fixture.adapter.exporter = async () => { const path = join(fixture.evidence, 'variants', 'same.png'); await mkdir(join(path, '..'), { recursive: true }); await realSentinel(path, '1'); return { path }; }; if (mode === 'boolean-only') fixture.adapter.exporter = async () => ({ path: 'missing.png' }); if (['orientation', 'alpha', 'coverage'].includes(mode)) fixture.adapter.exporter = async ({ variantId }) => { const path = join(fixture.evidence, 'variants', `${variantId}.png`); await mkdir(join(path, '..'), { recursive: true }); await badImage(path, mode); return { path }; }; const result = await qualify(request(fixture), options(fixture)); expect(result.status).toBe('blocked'); expect(result.candidate).toBeNull(); });
  it('blocks missing acknowledgement, stale runtime capability, missing roots, and boolean-only preparation', async () => { const lost = await setup({ writeContent: async () => undefined }); expect((await qualify(request(lost), options(lost))).status).toBe('blocked'); const stale = await setup({ capabilities: async () => ({ ...caps, version: 'stale' }) }); expect((await qualify(request(stale), options(stale))).status).toBe('blocked'); const noAck = await setup({ prepare: async () => ({ changed: true }), savePreparedCopy: async () => undefined }); expect((await qualify(request(noAck), options(noAck))).status).toBe('blocked'); const rootEscape = await setup(); expect((await qualify(request(rootEscape), { ...options(rootEscape), approvedTemplateRoots: ['/tmp'] })).status).toBe('blocked'); });
  it('blocks regenerated selectors whose fingerprint provenance is not exact', async () => { const regenerated = await setup(); const preparedSha = createHash('sha256').update('prepared-bytes').digest('hex'); regenerated.adapter.resolveSelectors = async () => { const proof = selectorProof(preparedSha); proof.targets[0]!.target.layerPath[0]!.fingerprint = 'regenerated'; return proof; }; const result = await qualify(request(regenerated), options(regenerated)); expect(result.status).toBe('blocked'); expect(result.errors[0]).toMatchObject({ code: 'SELECTOR_PROVENANCE_INVALID' }); });

  it('rejects variant paths that traverse a symlink component', async () => { const fixture = await setup(); const outside = await mkdtemp(join(tmpdir(), 'b15-path-outside-')); const link = join(fixture.evidence, 'variants'); await symlink(outside, link); fixture.adapter.exporter = async ({ variantId }) => { const path = join(link, `${variantId}.png`); await realSentinel(path, variantId); return { path }; }; const result = await qualify(request(fixture), options(fixture)); expect(result.status).toBe('blocked'); expect(result.errors[0]).toMatchObject({ code: 'EXPORT_PATH_ESCAPE' }); });
  it('rejects exported evidence through a symlink even when its target stays inside the root', async () => { const fixture = await setup(); const link = join(fixture.evidence, 'variants-link'); await symlink(fixture.evidence, link); fixture.adapter.exporter = async ({ variantId }) => { const path = join(link, `${variantId}.png`); await realSentinel(path, variantId); return { path }; }; const result = await qualify(request(fixture), options(fixture)); expect(result.status).toBe('blocked'); expect(result.errors[0]).toMatchObject({ code: 'EXPORT_PATH_ESCAPE' }); });
  it('rejects an evidence directory that is itself a symlink before any write', async () => { const fixture = await setup(); const outside = await mkdtemp(join(tmpdir(), 'b15-evidence-outside-')); const link = join(fixture.root, 'evidence-link'); await symlink(outside, link); const result = await qualify({ ...request(fixture), evidenceDirectory: link }, { ...options(fixture), approvedEvidenceRoots: [fixture.root] }); expect(result.status).toBe('blocked'); expect(result.errors[0]).toMatchObject({ code: 'PATH_ESCAPE' }); });
  it('rejects a symlinked evidence parent even when it resolves inside the approved root', async () => { const fixture = await setup(); const link = join(fixture.root, 'evidence-parent-link'); await symlink(fixture.evidence, link); const result = await qualify({ ...request(fixture), evidenceDirectory: join(link, 'child') }, options(fixture)); expect(result.status).toBe('blocked'); expect(result.errors[0]).toMatchObject({ code: 'PATH_ESCAPE' }); });
  it('does not clean up after an ambiguous mutation when barrier persistence fails', async () => { const fixture = await setup({ writeContent: async () => undefined, lock: { runExclusive: async (_id, fn) => fn(), markUnknownMutation: async () => { throw new Error('disk full'); } } }); const result = await qualify(request(fixture), options(fixture)); expect(result.status).toBe('blocked'); expect(result.errors[0]).toMatchObject({ code: 'RECOVERY_BARRIER_PERSIST_FAILED', category: 'ambiguousState' }); expect(fixture.counters()).toMatchObject({ txCleanups: 0, copyCleanups: 0 }); });
  it('retains the installation lock when ambiguity cannot persist its barrier', async () => { const fixture = await setup({ writeContent: async () => undefined }); const lock = new SessionLock({ lockPath: join(fixture.root, 'photoshop.lock'), installationPath: '/Applications/Adobe Photoshop.app', hostId: 'host-a', installationDigest: 'a'.repeat(64), processStartIdentity: 'start-a', randomToken: () => 'token-a' }); fixture.adapter.lock = { runExclusive: (id, fn, signal) => lock.runExclusive(id, fn, signal), markUnknownMutation: async () => { throw new Error('disk full'); } }; const result = await qualify(request(fixture), options(fixture)); expect(result.status).toBe('blocked'); expect(result.errors[0]).toMatchObject({ code: 'RECOVERY_BARRIER_PERSIST_FAILED' }); expect((await lock.tryAcquire({ jobId: 'other' })).acquired).toBe(false); expect(fixture.counters()).toMatchObject({ txCleanups: 0, copyCleanups: 0 }); });
  it('blocks dependency mutation and retains the unknown-mutation recovery barrier', async () => { const fixture = await setup(); const originalCreate = fixture.adapter.createWorkingCopy; fixture.adapter.createWorkingCopy = async (input) => { const copy = await originalCreate(input); const dependency = join(fixture.root, 'dependency.psb'); await writeFile(dependency, 'dependency'); return { ...copy, closure: [...copy.closure, { originalPath: dependency, sha256: '0'.repeat(64) }], verifyOriginals: async () => false }; }; expect((await qualify(request(fixture), options(fixture))).status).toBe('blocked'); expect(fixture.counters().txCleanups).toBe(1); expect(fixture.counters().copyCleanups).toBe(1); let marked = false; const lost = await setup({ writeContent: async () => undefined, lock: { runExclusive: async (_id, fn) => fn(), markUnknownMutation: async () => { marked = true; } } }); expect((await qualify(request(lost), options(lost))).status).toBe('blocked'); expect(marked).toBe(true); expect(lost.counters()).toMatchObject({ txCleanups: 0, copyCleanups: 0 }); });
  it('proves shared, independent and mixed resource routes with exact writes', async () => { const writes: string[] = []; const ids: Record<string, string> = { a: 'shared', b: 'shared', c: 'independent-1', d: 'independent-2' }; const result = await propagateSentinelByIdentity({ getContentIdentity: async (target) => ids[target]!, writeContent: async (identity) => { writes.push(identity); return { acknowledged: true }; } }, ['a', 'b', 'c', 'd'], '/tmp/sentinel.png'); expect(result.routes).toEqual(['a', 'b', 'c', 'd']); expect(result.writes).toHaveLength(3); expect(writes).toEqual(['shared', 'independent-1', 'independent-2']); });
});
it('delta correction payload uses measured residual once', async () => { const reference = { documentRoute: [], layerPath: [{ name: 'Reference', kind: 'pixel' as const, fingerprint: 'r' }] }; const target = { documentRoute: [], layerPath: [{ name: 'Target', kind: 'smartObject' as const, fingerprint: 't' }] }; let bounds = { left: 10, top: 10, right: 110, bottom: 110 }; const payloads: Array<{ dx: number; dy: number }> = []; let translations = 0; const adapter: PlacementAdapter = { capabilities: () => ({ liveQualified: true, supportedFitModes: ['cover'], independentAxisScale: false, scaleSemantics: 'uniform-percent', translationSemantics: 'delta', translationRoundingPx: 10 }), resolve: async (selector) => selector === reference ? { documentId: 'doc', layerId: 'ref', kind: 'pixel' } : { documentId: 'doc', layerId: 'target', kind: 'smartObject' }, readEffectiveBounds: async (identity) => identity.layerId === 'ref' ? { left: 0, top: 0, right: 100, bottom: 100 } : bounds, replaceContents: async (identity) => ({ acknowledged: true, ...identity, kind: 'smartObject' }), scale: async () => ({ acknowledged: true }), translate: async (_identity, command) => { const payload = command.payload as { dx: number; dy: number }; payloads.push(payload); translations += 1; const dx = translations === 1 ? payload.dx / 2 : payload.dx; bounds = { left: bounds.left + dx, top: bounds.top + dx, right: bounds.right + dx, bottom: bounds.bottom + dx }; return { acknowledged: true, rounding: true }; } }; const result = await placeAndFit({ adapter, reference, target, input: '/approved/sentinel.png', approvedInputs: ['/approved/sentinel.png'], fitMode: 'cover' }); expect(result.checks.every((check) => check.passed)).toBe(true); expect(payloads).toHaveLength(2); expect(payloads[1]).toEqual({ dx: -5, dy: -5 }); });
