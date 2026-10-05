import { copyFile, mkdtemp, mkdir, realpath, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createProductionPhotoshopRuntimeForTransport, ProductionRuntimeError, type ProductionPhotoshopRuntimeOptions } from '../../packages/photoshop/src/production.js';
import type { ProductionPhotoshopComposition } from '../../packages/photoshop/src/production.js';
import { createProductionPhotoshopRuntime } from '../../packages/photoshop/src/index.js';
import { toolSchemaDigest, type QualifiedToolBinding, type ToolDefinition } from '../../packages/photoshop/src/tool-map.js';
import type { ToolTransport } from '../../packages/photoshop/src/mcp-client.js';
import { SessionLock } from '../../packages/photoshop/src/session-lock.js';
import { sourceRootIdentity, type AssetLinkScanner } from '../../packages/photoshop/src/prepare-v2.js';
import { CanonicalTraceWriter } from '../../packages/photoshop/src/trace.js';
import type { PrepareRequestV2, QualificationResult, RecoveryRequestV2 } from '@ne-psd/contracts';

const roots: string[] = [];
const digest = (value: string): string => value.repeat(64).slice(0, 64);
const hash = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex');

async function options(): Promise<ProductionPhotoshopRuntimeOptions> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ne-psd-production-runtime-')));
  roots.push(root);
  const dirs = await Promise.all(['lock', 'template', 'source', 'evidence'].map(async (name) => {
    const path = join(root, name);
    await mkdir(path);
    return path;
  }));
  return {
    nodeExecutable: '/opt/node/bin/node',
    serverEntry: '/opt/server/node_modules/@alisaitteke/photoshop-mcp/dist/index.js',
    explicitArgs: ['--stdio'],
    installationId: 'photoshop-installation-1',
    installationDigest: digest('a'),
    processStartIdentity: 'process-start-1',
    lockRoot: dirs[0]!,
    toolSchemaDigest: digest('b'),
    templateRoots: [dirs[1]!],
    sourceRoots: [dirs[2]!],
    evidenceRoots: [dirs[3]!],
  };
}

function transport(tools: readonly ToolDefinition[], onClose?: () => void): ToolTransport {
  return {
    async listTools() { return { tools: [...tools] }; },
    async callTool() { throw new Error('unexpected mutation'); },
    async close() { onClose?.(); },
  };
}

const syntheticTools: ToolDefinition[] = [{
  name: 'fixture_scale',
  inputSchema: { type: 'object', properties: { percent: { type: 'number' } }, required: ['percent'], additionalProperties: false },
}];

const liveToolCases: Array<{ operation: QualifiedToolBinding['operation']; name: string; inputSchema: NonNullable<ToolDefinition['inputSchema']>; semantics: QualifiedToolBinding['semantics'] }> = [
  { operation: 'scale', name: 'live_scale', inputSchema: { type: 'object', properties: { percent: { type: 'number' } }, required: ['percent'], additionalProperties: false }, semantics: { scale: 'uniform-percent' } },
  { operation: 'translate', name: 'live_translate', inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'], additionalProperties: false }, semantics: { translation: 'absolute' } },
  ...(['place', 'replaceContents', 'setClipping', 'resize', 'flatten'] as const).map((operation) => ({ operation, name: `live_${operation}`, inputSchema: { type: 'object', properties: {}, additionalProperties: false }, semantics: {} })),
  { operation: 'setVisibility', name: 'live_setVisibility', inputSchema: { type: 'object', properties: { id: { type: 'string' }, visible: { type: 'boolean' } }, required: ['id', 'visible'], additionalProperties: false }, semantics: { visibility: { acknowledged: true, rereadsEffectiveAncestor: true, variantIds: ['1', '2', '3'] as const } } },
  { operation: 'export', name: 'live_export', inputSchema: { type: 'object', properties: { quality: { type: 'integer', minimum: 1, maximum: 100 }, format: { type: 'string', enum: ['jpeg', 'png'] } }, required: ['quality', 'format'], additionalProperties: false }, semantics: { export: { qualityUnit: '1-100', formats: ['jpeg', 'png'], actualPixelsToSrgb: true, renderingIntent: 'relative-colorimetric', embeddedProfile: 'sRGB', mode: 'RGB', bitDepth: 8, alpha: 'format-dependent' } } },
  { operation: 'convertProfile', name: 'live_convertProfile', inputSchema: { type: 'object', properties: { profile: { type: 'string' } }, required: ['profile'], additionalProperties: false }, semantics: { color: { actualPixels: true, renderingIntent: 'relative-colorimetric', embeddedProfile: 'sRGB', mode: 'RGB', bitDepth: 8 } } },
];
const liveTools: ToolDefinition[] = liveToolCases.map(({ name, inputSchema }) => ({ name, inputSchema }));
const liveBindings: QualifiedToolBinding[] = liveToolCases.map(({ operation, name, inputSchema, semantics }) => ({ operation, toolName: name, inputSchema, semantics, evidence: 'live-qualified' }));

function composition(selected: ProductionPhotoshopRuntimeOptions, overrides: Partial<ProductionPhotoshopComposition> = {}) {
  const defaults: ProductionPhotoshopComposition = {
    base: { capabilities: async () => { throw new Error('unused'); }, inspect: async () => { throw new Error('unused'); }, qualify: async () => { throw new Error('unused'); } },
    assetLinks: { readLinks: async () => ({ sourceSha256: digest('c'), complete: true as const, links: [] }) },
    templateLinks: { readLinks: async () => [] },
    templateRoot: selected.templateRoots[0]!,
    templateRootId: 'fixture-root',
    contextRoot: selected.evidenceRoots[0]!,
    renderOwned: async () => { throw new Error('unused'); },
    recoveryRuntime: async () => { throw new Error('unused'); },
  };
  return Object.assign(async () => ({ ...defaults, ...overrides }), { bindings: liveBindings });
}

async function runtimeFor(selected: ProductionPhotoshopRuntimeOptions, compose = composition(selected)) {
  return createProductionPhotoshopRuntimeForTransport({ ...selected, toolSchemaDigest: toolSchemaDigest(liveTools) }, transport(liveTools), compose);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('production Photoshop runtime boundary', () => {
  it('rejects relative and shell-bearing launch arguments before transport creation', async () => {
    const selected = await options();
    let created = false;
    await expect(createProductionPhotoshopRuntimeForTransport({ ...selected, nodeExecutable: 'node;evil' }, transport([], () => { created = true; }))).rejects.toMatchObject({ code: 'INVALID_LAUNCH' });
    expect(created).toBe(false);
  });

  it('rejects a tools/list schema digest mismatch and closes the transport', async () => {
    const selected = await options();
    let closed = false;
    const actual = toolSchemaDigest(syntheticTools);
    await expect(createProductionPhotoshopRuntimeForTransport({ ...selected, toolSchemaDigest: actual === selected.toolSchemaDigest ? digest('c') : selected.toolSchemaDigest }, transport(syntheticTools, () => { closed = true; }))).rejects.toMatchObject({ code: 'SCHEMA_DIGEST_MISMATCH' });
    expect(closed).toBe(true);
  });

  it('rejects synthetic or unqualified tool bindings even when the digest matches', async () => {
    const selected = await options();
    await expect(createProductionPhotoshopRuntimeForTransport({ ...selected, toolSchemaDigest: toolSchemaDigest(syntheticTools) }, transport(syntheticTools))).rejects.toMatchObject({ code: 'LIVE_TOOL_BINDINGS_UNAVAILABLE' });
  });

  it('rejects overlapping configured roots before connecting MCP', async () => {
    const selected = await options();
    await expect(createProductionPhotoshopRuntimeForTransport({ ...selected, sourceRoots: selected.templateRoots }, transport([]))).rejects.toMatchObject({ code: 'PRODUCTION_ROOT_OVERLAP' });
  });

  it('rejects symlink traversal in configured roots', async () => {
    const selected = await options();
    const root = roots[0]!;
    const target = join(root, 'source-link');
    await symlink(selected.sourceRoots[0]!, target);
    await expect(createProductionPhotoshopRuntimeForTransport({ ...selected, sourceRoots: [target] }, transport([]))).rejects.toMatchObject({ code: 'PRODUCTION_ROOT_INVALID' });
  });

  it('fails closed when the complete live operation map is absent', async () => {
    const selected = await options();
    await expect(createProductionPhotoshopRuntimeForTransport({ ...selected, toolSchemaDigest: toolSchemaDigest([]) }, transport([]))).rejects.toMatchObject({ code: 'LIVE_TOOL_BINDINGS_UNAVAILABLE' });
  });

  it('closes the transport on an invalid tools/list response and never constructs a synthetic backend', async () => {
    const selected = await options();
    let closed = false;
    const invalid: ToolDefinition[] = [{ name: 'broken' }];
    await expect(createProductionPhotoshopRuntimeForTransport({ ...selected, toolSchemaDigest: toolSchemaDigest(invalid) }, transport(invalid, () => { closed = true; }))).rejects.toMatchObject({ code: 'INVALID_TOOLS_LIST' });
    expect(closed).toBe(true);
  });

  it('uses a typed production error for all fail-closed capability exits', async () => {
    const selected = await options();
    try { await createProductionPhotoshopRuntimeForTransport({ ...selected, toolSchemaDigest: toolSchemaDigest([]) }, transport([])); }
    catch (error) { expect(error).toBeInstanceOf(ProductionRuntimeError); expect((error as ProductionRuntimeError).category).toBe('capability'); }
  });

  it('constructs a V2 backend from explicit live-qualified bindings and closes cleanly', async () => {
    const selected = await options();
    const runtime = await createProductionPhotoshopRuntimeForTransport({ ...selected, toolSchemaDigest: toolSchemaDigest(liveTools) }, transport(liveTools), composition(selected));
    expect(runtime.backend).toBeDefined();
    expect(runtime.schemaDigest).toBe(toolSchemaDigest(liveTools));
    await expect(runtime.close()).resolves.toBeUndefined();
  });

  it('exposes the composition-required public factory at the package entrypoint', async () => {
    const selected = await options();
    await expect(createProductionPhotoshopRuntime({ ...selected, nodeExecutable: 'node;invalid' }, composition(selected))).rejects.toMatchObject({ code: 'INVALID_LAUNCH' });
  });

  it('retains the installation barrier across contention and ambiguous mutation', async () => {
    const selected = await options();
    const runtime = await runtimeFor(selected);
    await runtime.lock.acquire({ operationId: 'ambiguous-operation' });
    const contender = new SessionLock({ lockPath: join(selected.lockRoot, 'installation.lock'), installationPath: selected.installationId, hostId: `${process.platform}:${process.env.HOSTNAME ?? 'unknown'}`, installationDigest: selected.installationDigest, processStartIdentity: selected.processStartIdentity });
    await expect(contender.tryAcquire({ operationId: 'contender' })).resolves.toMatchObject({ acquired: false, reason: 'PHOTOSHOP_BUSY' });
    await runtime.lock.markUnknownMutation();
    await expect(runtime.close()).rejects.toMatchObject({ code: 'LIVE_TOOL_BINDINGS_UNAVAILABLE' });
    await runtime.lock.clearRecoveryBarrier();
    await expect(runtime.close()).resolves.toBeUndefined();
  });

  it('blocks a production prepare at the scanner and changed-original boundaries', async () => {
    const selected = await options();
    const source = Buffer.from('PSD bytes requiring a qualified scanner');
    const sourcePath = join(selected.sourceRoots[0]!, 'source.psd');
    const stage = join(selected.evidenceRoots[0]!, 'prepare-stage');
    await mkdir(stage);
    await writeFile(sourcePath, source);
    const request = JSON.parse(await readFile('tests/fixtures/contracts/prepare-request.v2.valid.json', 'utf8')) as PrepareRequestV2;
    request.stagingDirectory = stage;
    request.sourceRoot.path = selected.sourceRoots[0]!;
    request.sourceRoot.identity = (await sourceRootIdentity(selected.sourceRoots[0]!)).identity;
    request.asset.source.relativePath = 'source.psd';
    request.asset.source.sha256 = hash(source);
    request.asset.sourceBytes = source.byteLength;
    const incomplete: AssetLinkScanner = { readLinks: async () => ({ sourceSha256: hash(source), complete: false as true, links: [] }) };
    const first = await runtimeFor(selected, composition(selected, { assetLinks: incomplete }));
    const blocked = await first.backend.prepareOwnedInput(request, new AbortController().signal);
    expect(blocked).toMatchObject({ status: 'blocked', errors: [{ code: 'LINK_SCAN_UNAVAILABLE' }] });
    await first.close();

    const changedStage = join(selected.evidenceRoots[0]!, 'prepare-stage-changed');
    await mkdir(changedStage);
    request.stagingDirectory = changedStage;
    const changed: AssetLinkScanner = { readLinks: async (path) => { await writeFile(path, 'changed PSD bytes'); return { sourceSha256: hash(source), complete: true, links: [] }; } };
    const second = await runtimeFor(selected, composition(selected, { assetLinks: changed }));
    const changedResult = await second.backend.prepareOwnedInput(request, new AbortController().signal);
    expect(changedResult).toMatchObject({ status: 'blocked', errors: [{ code: 'SOURCE_CHANGED' }] });
    await second.close();
  });

  it('rejects wrong recovery identity and preserves an existing barrier', async () => {
    const selected = await options();
    const runtime = await runtimeFor(selected);
    await runtime.lock.acquire({ operationId: 'owned-operation' });
    await runtime.lock.markUnknownMutation();
    const request: RecoveryRequestV2 = { schemaVersion: 2, jobId: 'job', assetId: 'asset', attempt: 1, operationId: 'wrong-operation' };
    await expect(runtime.backend.recover(request, new AbortController().signal)).resolves.toMatchObject({ safe: false, released: false, releaseProof: null });
    expect(runtime.lock.journalMetadata).not.toBeNull();
    await expect(runtime.close()).rejects.toMatchObject({ code: 'LIVE_TOOL_BINDINGS_UNAVAILABLE' });
    await runtime.lock.clearRecoveryBarrier();
    await runtime.close();
  });

  it('keeps absent qualification capability blocked through the production backend', async () => {
    const selected = await options();
    const result: QualificationResult = { status: 'blocked', candidate: null, checks: [], evidencePaths: [], errors: [{ code: 'QUALIFICATION_UNAVAILABLE', category: 'capability', message: 'qualification is unavailable', retryable: false, evidencePaths: [] }] };
    const runtime = await runtimeFor(selected, composition(selected, { base: { capabilities: async () => { throw new Error('unused'); }, inspect: async () => { throw new Error('unused'); }, qualify: async () => result } }));
    await expect(runtime.backend.qualify({} as never, new AbortController().signal)).resolves.toMatchObject({ status: 'blocked', errors: [{ code: 'QUALIFICATION_UNAVAILABLE' }] });
    await runtime.close();
  });

  it('fails closed when a production renderer returns incomplete V2 evidence', async () => {
    const selected = await options();
    const sourceRoot = selected.sourceRoots[0]!;
    const templateRoot = selected.templateRoots[0]!;
    const stage = join(selected.evidenceRoots[0]!, 'render-stage');
    await mkdir(join(sourceRoot, 'assets'));
    await mkdir(join(templateRoot, 'assets'));
    await mkdir(stage);
    await copyFile('tests/fixtures/contracts/assets/source.png', join(sourceRoot, 'assets/source.png'));
    await copyFile('tests/fixtures/contracts/assets/template.psd', join(templateRoot, 'assets/template.psd'));
    const sourceBytes = await readFile(join(sourceRoot, 'assets/source.png'));
    const templateBytes = await readFile(join(templateRoot, 'assets/template.psd'));
    const prepare = JSON.parse(await readFile('tests/fixtures/contracts/prepare-request.v2.valid.json', 'utf8')) as PrepareRequestV2;
    prepare.stagingDirectory = stage;
    prepare.sourceRoot.path = sourceRoot;
    prepare.sourceRoot.identity = (await sourceRootIdentity(sourceRoot)).identity;
    prepare.asset.source.sha256 = hash(sourceBytes);
    prepare.asset.sourceBytes = sourceBytes.byteLength;
    prepare.profile.template.sha256 = hash(templateBytes);
    prepare.profile.template.rootId = 'fixture-root';
    const preparedRuntime = await runtimeFor(selected);
    const prepared = await preparedRuntime.backend.prepareOwnedInput(prepare, new AbortController().signal);
    expect(prepared.status).toBe('prepared');
    await preparedRuntime.close();
    if (prepared.status !== 'prepared') return;
    await mkdir(join(stage, 'scratch/input'), { recursive: true });
    await copyFile(join(sourceRoot, 'assets/source.png'), join(stage, 'scratch/input/source.png'));
    const render = JSON.parse(await readFile('tests/fixtures/contracts/render-request.v2.valid.json', 'utf8')) as any;
    render.stagingDirectory = stage;
    render.profile = prepare.profile;
    render.asset = prepare.asset;
    render.ownedInput.source = { relativePath: 'scratch/input/source.png', sha256: prepare.asset.source.sha256, bytes: prepare.asset.sourceBytes };
    render.ownedInput.dependencies = [];
    render.ownedInput.closureProof = prepared.closureProof;
    render.ownedInput.sourceRootIdentity = prepare.sourceRoot.identity;
    const incompleteRenderer = async (request: any, ownedSourcePath: string, workingTemplatePath: string) => {
      const document = new CanonicalTraceWriter(stage, join(stage, 'document-trace.jsonl'), { operationId: request.operationId, requestId: 'document' });
      await document.file('pre', 'document-content', workingTemplatePath);
      await document.file('post', 'document-content', workingTemplatePath);
      const tools = new CanonicalTraceWriter(stage, join(stage, 'tool-trace.jsonl'), { operationId: request.operationId, requestId: 'tool' });
      await tools.file('pre', 'owned-source', ownedSourcePath);
      await tools.file('post', 'owned-source', ownedSourcePath);
      return {
        evidence: { schemaVersion: 1, jobId: request.jobId, assetId: request.asset.assetId, attempt: request.attempt,
          profileSha256: request.profile.profileSha256, sourceSha256: request.asset.source.sha256, toolSchemaSha256: request.profile.toolSchemaSha256,
          geometry: [], visibility: [], artifacts: (['1', '2', '3'] as const).map((variantId) => ({ variantId, path: `assets/${variantId}.jpg`, sha256: hash(variantId), bytes: 1, colorSpace: 'sRGB' as const, width: 1, height: 1, format: 'jpeg' as const })), checks: [], documentTracePath: 'document-trace.jsonl', toolTracePath: 'tool-trace.jsonl' },
        openedSourcePath: ownedSourcePath, openedTemplatePath: workingTemplatePath, quiescent: true as const, ownedDocumentsRemaining: 0 as const,
      };
    };
    const runtime = await runtimeFor(selected, composition(selected, { renderOwned: incompleteRenderer }));
    await expect(runtime.backend.render(render, new AbortController().signal)).rejects.toThrow('RENDER_QA_INCOMPLETE');
    await runtime.close();
  });
});
