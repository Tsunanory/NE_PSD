import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  parseLiveMachine, probeLiveMachine, readLiveMachine, runLiveQualification,
  type LiveComposition, type LiveMachine,
} from '../../packages/photoshop/src/live.js';
import { readFixture } from '../fixtures/read-fixture.js';

const pinnedNode = '/Users/tsunanory/Desktop/Engines/NE_PSD/.worktrees/.toolchains/node-v22.23.2-darwin-arm64/bin/node';
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
async function machine(): Promise<LiveMachine> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ne-psd-b15-live-')));
  const installationPath = join(root, 'Photoshop.app');
  const installationExecutable = join(installationPath, 'Contents', 'MacOS', 'Photoshop');
  const serverEntry = join(root, 'node_modules', '@alisaitteke', 'photoshop-mcp', 'dist', 'index.js');
  const sourceRoot = join(root, 'template-source');
  const assetRoot = join(root, 'asset-source');
  const workRoot = join(root, 'work');
  const evidenceRoot = join(root, 'evidence');
  const sourcePath = join(sourceRoot, 'мокап_готово.psd');
  const assetPath = join(assetRoot, 'вход.png');
  await Promise.all([mkdir(dirname(installationExecutable), { recursive: true }), mkdir(dirname(serverEntry), { recursive: true }), mkdir(sourceRoot), mkdir(assetRoot), mkdir(join(workRoot, 'locks'), { recursive: true }), mkdir(evidenceRoot)]);
  await Promise.all([writeFile(installationExecutable, ''), writeFile(serverEntry, ''), writeFile(sourcePath, 'template'), writeFile(assetPath, 'asset')]);
  await chmod(installationExecutable, 0o755);
  return { schemaVersion: 1, platform: 'darwin', backendId: 'alisaitteke', installationPath, installationExecutable, nodeExecutable: pinnedNode, serverEntry, sourceRoot, sourcePath, assetRoot, assetPath, workRoot, evidenceRoot, lockPath: join(workRoot, 'locks', 'installation') };
}

function fakeComposition(calls: string[], corruptOutput = false): LiveComposition {
  const inspection = readFixture<Awaited<ReturnType<LiveComposition['inspect']>>>('inspection.live.json');
  const proposal = readFixture<Awaited<ReturnType<LiveComposition['propose']>>>('proposal.valid.json');
  const qualification = readFixture<Awaited<ReturnType<LiveComposition['qualify']>>>('qualification-result.json');
  const profile = readFixture<Awaited<ReturnType<LiveComposition['seal']>>>('profile.qualified.json');
  const render = readFixture<Awaited<ReturnType<LiveComposition['renderCase']>>>('evidence.pass.json');
  return {
    kind: 'test',
    inspect: async () => { calls.push('inspect'); return inspection; },
    prepareTemplate: async (sourcePath, attemptRoot) => {
      calls.push('prepare');
      const workingTemplatePath = join(attemptRoot, 'template.psd');
      await copyFile(sourcePath, workingTemplatePath);
      return { workingTemplatePath, dependencies: [] };
    },
    propose: async () => { calls.push('propose'); return proposal; },
    qualify: async () => { calls.push('qualify'); return qualification; },
    seal: async (candidate, mode, format) => {
      calls.push('seal:' + mode + ':' + format);
      return { ...profile, template: candidate.template, fitMode: mode, output: { ...profile.output, format } };
    },
    renderCase: async ({ mode, format, profile: selected, ownedAssetPath, stagingDirectory }) => {
      calls.push('render:' + mode + ':' + format);
      const assetSha = digest(await readFile(ownedAssetPath));
      for (const name of [render.documentTracePath, render.toolTracePath, ...render.checks.map((check) => check.evidencePath)]) {
        await mkdir(dirname(join(stagingDirectory, name)), { recursive: true });
        await writeFile(join(stagingDirectory, name), 'observed-' + name);
      }
      const artifacts = await Promise.all((['1', '2', '3'] as const).map(async (variantId) => {
        const image = sharp({ create: { width: selected.output.width, height: selected.output.height, channels: 4, background: { r: 15, g: 40, b: 70, alpha: 1 } } }).withIccProfile('srgb');
        const bytes = await (format === 'jpeg' ? image.jpeg({ quality: 90 }).toBuffer() : image.png().toBuffer());
        const path = 'variant-' + variantId + (format === 'jpeg' ? '.jpg' : '.png');
        await writeFile(join(stagingDirectory, path), corruptOutput && variantId === '2' ? Buffer.from('tampered') : bytes);
        return { ...render.artifacts.find((item) => item.variantId === variantId)!, variantId, path, format, sha256: digest(bytes), bytes: bytes.byteLength };
      }));
      return { ...render, profileSha256: selected.profileSha256, sourceSha256: assetSha, geometry: [{ target: selected.targets[0]!.target, reference: { left: 0, top: 0, right: 800, bottom: 600 }, placed: { left: 0, top: 0, right: 800, bottom: 600 }, fitMode: mode, clipped: true, adjacentToReference: true }], visibility: (['1', '2', '3'] as const).map((variantId) => ({ variantId, visibleVariantIds: [variantId] })), artifacts };
    },
    cleanup: async () => { calls.push('cleanup'); return { quiescent: true, ownedDocuments: [], foreignDocumentsPreserved: true }; },
  };
}

describe('B15 live machine and composition gate', () => {
  it('reports absent config without any Photoshop or MCP call', async () => {
    const probe = await readLiveMachine(join(tmpdir(), 'ne-psd-missing-live-machine-' + process.pid + '.json'));
    expect(probe).toMatchObject({ config: null, blocked: [{ code: 'B15_LIVE_CONFIG_MISSING' }] });
  });

  it('rejects config-supplied steps, bindings, profiles and execution claims', async () => {
    const config = await machine();
    for (const field of ['steps', 'bindings', 'templateProfileSha256', 'toolSchemaSha256', 'qualificationId', 'executor']) {
      expect(() => parseLiveMachine({ ...config, [field]: field === 'steps' ? [] : 'self-asserted' })).toThrow(/B15_LIVE_CONFIG_INVALID/);
    }
    expect((await probeLiveMachine(config)).map((item) => item.code)).toEqual([]);
    expect(await runLiveQualification(config)).toMatchObject({ status: 'blocked', blocks: [{ code: 'B15_LIVE_COMPOSITION_UNAVAILABLE' }] });
  });

  it('rejects symlinked source and overlapping output roots before execution', async () => {
    const config = await machine();
    const linked = join(config.sourceRoot, 'linked.psd');
    await symlink(config.sourcePath, linked);
    const blocks = await probeLiveMachine({ ...config, sourcePath: linked, evidenceRoot: config.workRoot });
    expect(blocks.map((item) => item.code)).toContain('B15_PATH_INVALID');
    expect(blocks.map((item) => item.code)).toContain('B15_ROOT_OVERLAP');
  });

  it('rejects a different Node version even when the executable is named node', async () => {
    const config = await machine();
    const nodeExecutable = join(config.workRoot, 'node');
    await writeFile(nodeExecutable, '#!/bin/sh\necho v25.9.0\n');
    await chmod(nodeExecutable, 0o755);
    expect((await probeLiveMachine({ ...config, nodeExecutable })).map((item) => item.code)).toContain('B15_PINNED_RUNTIME_INVALID');
  });

  it('runs six sealed fit/export cases in order with byte-checked artifacts and cleanup', async () => {
    const config = await machine();
    const calls: string[] = [];
    const result = await runLiveQualification(config, fakeComposition(calls));
    expect(result.status).toBe('protocol-exercised');
    expect(calls.slice(0, 4)).toEqual(['inspect', 'prepare', 'propose', 'qualify']);
    expect(calls.filter((call) => call.startsWith('render:'))).toEqual([
      'render:cover:jpeg', 'render:cover:png', 'render:contain:jpeg', 'render:contain:png', 'render:stretch:jpeg', 'render:stretch:png',
    ]);
    expect(calls.at(-1)).toBe('cleanup');
    if (result.status !== 'blocked') expect(JSON.parse(await readFile(result.evidencePath, 'utf8')).cases).toHaveLength(6);
  });

  it('blocks a tampered artifact and still asks the composition to clean up', async () => {
    const config = await machine();
    const calls: string[] = [];
    const result = await runLiveQualification(config, fakeComposition(calls, true));
    expect(result).toMatchObject({ status: 'blocked', blocks: [{ code: 'B15_LIVE_SEQUENCE_FAILED' }] });
    expect(calls.at(-1)).toBe('cleanup');
  });
});

const configPath = resolve(process.cwd(), 'docs/photoshop/live-machine.json');
describe('optional real machine', () => {
  it('stays blocked without a wired production composition', async () => {
    const probe = await readLiveMachine(configPath);
    if (!probe.config) {
      console.info('B15_LIVE_BLOCKED: ' + probe.blocked.map((item) => item.code).join(','));
      expect(probe.blocked.length).toBeGreaterThan(0);
      return;
    }
    const result = await runLiveQualification(probe.config);
    if (result.status === 'blocked') console.info('B15_LIVE_BLOCKED: ' + result.blocks.map((item) => item.code).join(','));
    expect(result.status).toBe('blocked');
    if (result.status === 'blocked') expect(result.blocks.length).toBeGreaterThan(0);
  });
});
