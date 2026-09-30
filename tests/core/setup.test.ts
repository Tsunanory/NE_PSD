import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConfigurationProposal, InspectionReport, IntelligenceService, PhotoshopBackend, QualificationResult } from '@ne-psd/contracts';
import { createSetupService } from '../../packages/core/src/setup-service.js';
import type { QualificationRecord } from '../../packages/core/src/job-repository.js';

const fixture = (name: string): unknown => JSON.parse(readFileSync(resolve('tests/fixtures/contracts', name), 'utf8'));
const sha = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function harness(mutate?: (result: QualificationResult, evidenceDirectory: string, working: string) => void) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ne-psd-setup-'))); roots.push(root);
  const original = join(root, 'original.psd');
  const bytes = 'synthetic PSD bytes'; writeFileSync(original, bytes);
  const qualificationRoot = join(root, 'qualification');
  const working = join(qualificationRoot, 'working', 'template.psd');
  mkdirSync(join(qualificationRoot, 'working'), { recursive: true }); writeFileSync(working, bytes);
  const inspection = fixture('inspection.live.json') as InspectionReport;
  inspection.template.sha256 = sha(bytes);
  for (const document of inspection.documents) if (document.source) document.source.sha256 = sha(bytes);
  const proposal = fixture('proposal.valid.json') as ConfigurationProposal;
  for (const path of [...inspection.evidencePaths, ...(inspection.capabilities?.evidencePaths ?? [])]) {
    const destination = join(qualificationRoot, path);
    mkdirSync(resolve(destination, '..'), { recursive: true });
    writeFileSync(destination, '{}');
  }
  const candidate = (fixture('qualification-result.json') as QualificationResult).candidate!;
  candidate.template = { rootId: `${inspection.template.rootId}:qualification`, relativePath: 'prepared/template.psd', sha256: sha(bytes) };
  const recorded: QualificationRecord[] = [];
  const backend: PhotoshopBackend = {
    async capabilities() { return inspection.capabilities!; },
    async inspect() { return inspection; },
    async qualify(request) {
      const evidencePath = join(request.evidenceDirectory, 'prepared', 'template.psd');
      mkdirSync(join(request.evidenceDirectory, 'prepared'), { recursive: true }); writeFileSync(evidencePath, bytes);
      const ids = ['geometry', 'linkage', 'clipping', 'identity', 'variant-1', 'variant-2', 'variant-3', 'source-integrity', 'cleanup', ...['1', '2', '3'].map((id) => `sentinel-correspondence-${id}-target-1`)];
      const checks = ids.map((id) => ({ id, passed: true, evidencePath: `checks/${id}.json` }));
      mkdirSync(join(request.evidenceDirectory, 'checks'));
      for (const check of checks) writeFileSync(join(request.evidenceDirectory, check.evidencePath), '{}');
      const result: QualificationResult = { status: 'qualified', candidate, checks, evidencePaths: checks.map((check) => check.evidencePath), errors: [] };
      mutate?.(result, request.evidenceDirectory, working);
      return result;
    },
    async render() { throw new Error('unused'); },
    async recover() { throw new Error('unused'); },
  };
  const intelligence: IntelligenceService = {
    async propose() { return proposal; },
    async review() { throw new Error('unused'); },
    async inspectModelProfile() { return { available: true, errors: [] }; },
    async qualifyModelProfile() { return { qualified: true, evidencePaths: [], errors: [] }; },
  };
  const service = createSetupService({ backend, intelligence, repository: { recordQualification: (record) => { recorded.push(record); } }, qualificationRoot });
  return { service, original, working, inspection, proposal, recorded };
}

async function prepare(h: ReturnType<typeof harness>) {
  const signal = new AbortController().signal;
  await h.service.inspectTemplate(h.original, signal);
  await h.service.proposeConfiguration({ instruction: 'Use observed groups', inspectionId: h.inspection.inspectionId, modelProfileId: 'model-1' }, signal);
  return signal;
}

describe('setup qualification boundary', () => {
  it('seals a profile only after backend evidence and selected selectors verify', async () => {
    const h = harness(); const signal = await prepare(h);
    const profile = await h.service.qualifyTemplate({ inspectionId: h.inspection.inspectionId, proposal: h.proposal, workingTemplatePath: h.working }, signal);
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]?.profileSha256).toBe(profile.profileSha256);
    expect((h.recorded[0]?.evidence as { files: unknown[] }).files).toHaveLength(12);
    expect(readFileSync(h.original, 'utf8')).toBe('synthetic PSD bytes');
  });

  it('rejects a backend candidate that substitutes an unobserved selector', async () => {
    const h = harness((result) => { result.candidate!.targets[0]!.target.layerPath[0]!.fingerprint = 'substituted'; });
    const signal = await prepare(h);
    await expect(h.service.qualifyTemplate({ inspectionId: h.inspection.inspectionId, proposal: h.proposal, workingTemplatePath: h.working }, signal)).rejects.toThrow(/selectors/);
    expect(h.recorded).toHaveLength(0);
  });

  it('rejects missing evidence and mutation of the supplied working template', async () => {
    const missing = harness((result, directory) => rmSync(join(directory, result.checks[0]!.evidencePath)));
    const signal = await prepare(missing);
    await expect(missing.service.qualifyTemplate({ inspectionId: missing.inspection.inspectionId, proposal: missing.proposal, workingTemplatePath: missing.working }, signal)).rejects.toThrow();
    expect(missing.recorded).toHaveLength(0);
    const changed = harness((_result, _directory, working) => writeFileSync(working, 'mutated'));
    const changedSignal = await prepare(changed);
    await expect(changed.service.qualifyTemplate({ inspectionId: changed.inspection.inspectionId, proposal: changed.proposal, workingTemplatePath: changed.working }, changedSignal)).rejects.toThrow(/mutated/);
    expect(changed.recorded).toHaveLength(0);
  });

  it('does not seal a backend result missing mandatory sentinel proof', async () => {
    const h = harness((result) => {
      const omitted = result.checks.pop()!;
      result.evidencePaths = result.evidencePaths.filter((path) => path !== omitted.evidencePath);
    });
    const signal = await prepare(h);
    await expect(h.service.qualifyTemplate({ inspectionId: h.inspection.inspectionId, proposal: h.proposal, workingTemplatePath: h.working }, signal)).rejects.toThrow(/sentinel correspondence/);
    expect(h.recorded).toHaveLength(0);
  });

  it('refuses a working path outside the job-owned qualification root', async () => {
    const h = harness(); const signal = await prepare(h);
    await expect(h.service.qualifyTemplate({ inspectionId: h.inspection.inspectionId, proposal: h.proposal, workingTemplatePath: h.original }, signal)).rejects.toThrow(/outside qualification root/);
  });

  it('rejects changed inspection evidence before backend qualification', async () => {
    const h = harness(); const signal = await prepare(h);
    writeFileSync(join(resolve(h.working, '..', '..'), h.inspection.evidencePaths[0]!), 'changed');
    await expect(h.service.qualifyTemplate({ inspectionId: h.inspection.inspectionId, proposal: h.proposal, workingTemplatePath: h.working }, signal)).rejects.toThrow(/inspection evidence changed/);
    expect(h.recorded).toHaveLength(0);
  });

  it('rejects a redirected evidence parent', async () => {
    const h = harness(); const signal = await prepare(h);
    symlinkSync(resolve(h.working, '..'), join(resolve(h.working, '..', '..'), 'qualifications'));
    await expect(h.service.qualifyTemplate({ inspectionId: h.inspection.inspectionId, proposal: h.proposal, workingTemplatePath: h.working }, signal)).rejects.toThrow(/redirected/);
    expect(h.recorded).toHaveLength(0);
  });
});
