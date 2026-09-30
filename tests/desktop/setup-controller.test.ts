import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeJobService, FakeSetupService } from '../../apps/desktop/src/main/services.js';
import { RootRegistry } from '../../apps/desktop/src/main/paths.js';
import { SetupController, type Preview } from '../../apps/desktop/src/main/setup-controller.js';
import { loadFixture } from '@ne-psd/contracts/testing';
import type { ModelProfile } from '@ne-psd/contracts';
import { modelCase } from './fixtures/model-cases.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const fixture = resolve('tests/fixtures/contracts/assets/template.psd');
function harness(options: { production?: boolean; previews?: (previews: Preview[]) => Preview[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ne-psd-controller-')); dirs.push(dir);
  const template = join(dir, 'master.psd'); cpSync(fixture, template);
  const assets = join(dir, 'assets'); const output = join(dir, 'output'); mkdirSync(assets); mkdirSync(output);
  cpSync(resolve('tests/fixtures/contracts/assets/source.png'), join(assets, 'кот.png'));
  writeFileSync(join(assets, 'notes.txt'), 'skip');
  let next: string | null = null;
  const pickers = { select: vi.fn(async () => next) };
  const setup = new FakeSetupService(); const jobs = new FakeJobService();
  const productionEvidence = options.production ? modelCase('Q4') : null;
  const profile = productionEvidence?.selectedProfile ?? loadFixture<ModelProfile>('model.local.json');
  const modelOption = { profile, evidence: {
    label: 'Qwen3.8-27B' as const, modelId: profile.modelId, artifactSha256: profile.provenance.kind === 'local' ? profile.provenance.artifactSha256 : '',
    runtimeVersion: profile.provenance.kind === 'local' ? profile.provenance.runtimeVersion : '', chatTemplateSha256: profile.provenance.kind === 'local' ? profile.provenance.chatTemplateSha256 : '',
    quantization: 'Q4' as const, contextTokens: profile.contextTokens, maxOutputTokens: profile.maxOutputTokens, capabilities: profile.capabilities,
    benchmark: { passed: true, latencyMs: 1 }, resources: { peakRamGb: 1, peakVramGb: 1, requiredHeadroomGb: 1 },
    artifactVerified: true, endpointReachable: true, reviewGateAvailable: true, synthetic: !options.production, selectedProfile: profile,
  } };
  if (productionEvidence) modelOption.evidence = productionEvidence;
  const controller = new SetupController({ setup, jobs, roots: new RootRegistry(), pickers, userDataDirectory: join(dir, 'state'),
    models: [modelOption], reviewPolicySha256: 'a'.repeat(64), developmentFake: !options.production,
    previews: async (qualified) => {
      const previews = await Promise.all((['1', '2', '3'] as const).map(async (variantId) => {
        const bytes = options.production ? await sharp({ create: { width: qualified.output.width, height: qualified.output.height, channels: 3, background: '#ffffff' } }).jpeg().toBuffer() : readFileSync(resolve(`tests/fixtures/contracts/assets/variant-${variantId}.jpg`));
        return { variantId, profileSha256: qualified.profileSha256, sha256: createHash('sha256').update(bytes).digest('hex'), dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}`, synthetic: !options.production };
      }));
      return options.previews?.(previews) ?? previews;
    },
  });
  return { controller, pickers, setNext: (value: string | null) => { next = value; }, template, assets, output, dir, jobs, setup, modelOption };
}

describe('main-owned setup workflow', () => {
  it('preserves selection on cancelled pickers and keeps rejected asset reasons', async () => {
    const h = harness(); h.setNext(h.template);
    const first = await h.controller.chooseTemplate();
    h.setNext(null); expect(await h.controller.chooseTemplate()).toBeNull();
    expect(h.controller.currentTemplate()).toEqual(first);
    h.setNext(h.assets); const selected = await h.controller.chooseAssets();
    expect(selected?.assets).toHaveLength(1);
    expect(selected?.rejected[0]?.reason).toContain('Unsupported');
  });

  it('qualifies only a current inspected selection on an owned copy and requires preview confirmation', async () => {
    const h = harness(); h.setNext(h.template); await h.controller.chooseTemplate();
    h.setNext(h.assets); await h.controller.chooseAssets();
    h.setNext(h.output); await h.controller.chooseOutput();
    const inspection = await h.controller.inspect();
    const proposal = await h.controller.propose('Use the inspected target', 'model-local-1');
    const result = await h.controller.qualify(proposal);
    expect(result.previews).toHaveLength(3);
    expect(h.controller.currentProfile()).toBeNull();
    expect(await h.controller.confirmPreviews(result.profile.profileSha256)).toEqual(result.profile);
    expect(h.controller.currentProfile()).toEqual(result.profile);
    expect(readFileSync(h.template).equals(readFileSync(fixture))).toBe(true);
    expect(inspection.candidates.some((candidate) => candidate.roleHints.includes('target'))).toBe(true);
    h.setNext(h.template); await h.controller.chooseTemplate();
    expect(h.controller.currentProfile()).toBeNull();
  });
});

async function prepare(h: ReturnType<typeof harness>) {
  h.setNext(h.template); await h.controller.chooseTemplate();
  h.setNext(h.assets); await h.controller.chooseAssets();
  h.setNext(h.output); await h.controller.chooseOutput();
  await h.controller.inspect();
  return h.controller.propose('Use inspected target', h.modelOption.profile.profileId);
}

describe('trusted qualification gates', () => {
  it.each(['stale profile', 'wrong digest', 'duplicate variant', 'missing variant', 'invalid image', 'wrong dimensions', 'synthetic production'] as const)('rejects %s preview', async (failure) => {
    const h = harness({ production: true, previews: (previews) => {
      if (failure === 'stale profile') previews[0] = { ...previews[0]!, profileSha256: 'f'.repeat(64) };
      if (failure === 'wrong digest') previews[0] = { ...previews[0]!, sha256: 'f'.repeat(64) };
      if (failure === 'duplicate variant') previews[1] = { ...previews[1]!, variantId: '1' };
      if (failure === 'missing variant') previews.pop();
      if (failure === 'invalid image') {
        const bytes = Buffer.from('not a JPEG');
        previews[0] = { ...previews[0]!, sha256: createHash('sha256').update(bytes).digest('hex'), dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}` };
      }
      if (failure === 'wrong dimensions') {
        const bytes = readFileSync(resolve('tests/fixtures/contracts/assets/source.png'));
        previews[0] = { ...previews[0]!, sha256: createHash('sha256').update(bytes).digest('hex'), dataUrl: `data:image/png;base64,${bytes.toString('base64')}` };
      }
      if (failure === 'synthetic production') previews[0] = { ...previews[0]!, synthetic: true };
      return previews;
    } });
    await expect(h.controller.qualify(await prepare(h))).rejects.toThrow('three bound image previews');
  });

  it('uses fresh service qualification with trusted catalog capacity and blocks stale or failed evidence', async () => {
    const h = harness({ production: true });
    const result = await h.controller.qualify(await prepare(h));
    await h.controller.confirmPreviews(result.profile.profileSha256);
    h.controller.selectModels(h.modelOption.profile.profileId, h.modelOption.profile.profileId);
    await expect(h.controller.startJob()).rejects.toThrow('model qualification is stale');
    await h.controller.qualifyModel(h.modelOption.profile);
    expect(h.controller.catalog().models[0]?.evidence.qualification?.qualified).toBe(true);
    await expect(h.controller.startJob()).resolves.toHaveProperty('jobId');
    h.modelOption.evidence.benchmark.passed = false;
    await expect(h.controller.startJob()).rejects.toThrow('model evidence or capacity');
  });

  it('invalidates qualification when a catalog profile changes or service requalification fails', async () => {
    const h = harness({ production: true });
    const result = await h.controller.qualify(await prepare(h));
    await h.controller.confirmPreviews(result.profile.profileSha256);
    h.controller.selectModels(h.modelOption.profile.profileId, h.modelOption.profile.profileId);
    await h.controller.qualifyModel(h.modelOption.profile);
    h.modelOption.profile.maxOutputTokens += 1;
    await expect(h.controller.startJob()).rejects.toThrow('model qualification is stale');
    h.modelOption.profile.maxOutputTokens -= 1;
    h.setup.qualifyModelProfile = vi.fn(async () => ({ qualified: false, evidencePaths: [], errors: [] }));
    await h.controller.qualifyModel(h.modelOption.profile);
    await expect(h.controller.startJob()).rejects.toThrow('model qualification is stale');
  });
});
