import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EvidenceBundleManifestSchema,
  JobSpecSchema,
  ReviewPolicySchema,
  RenderRequestSchema,
  validateQualificationRequest,
  type JobEvent,
} from '@ne-psd/contracts';
import { FakePhotoshop } from '../../packages/contracts/src/testing/fake-photoshop.js';
import { FakeIntelligence } from '../../packages/contracts/src/testing/fake-intelligence.js';
import { FakeJobService } from '../../packages/contracts/src/testing/fake-job-service.js';
import { FakeSetupService } from '../../packages/contracts/src/testing/fake-setup-service.js';
import {
  loadFixture,
  RUNTIME_REQUIREMENT_IDS,
  testOnlyPath,
} from '../../packages/contracts/src/testing/fixture-loader.js';

const abort = new AbortController().signal;

describe('foundation fakes', () => {
  it('renders three real decodable, test-only artifacts with deterministic operations', async () => {
    const request = RenderRequestSchema.parse(loadFixture('render-request.valid.json'));
    const photoshop = new FakePhotoshop();
    const evidence = await photoshop.render(request, abort);
    const bundle = photoshop.lastBundle;
    expect(bundle?.testOnly).toBe(true);
    expect(bundle?.artifacts).toHaveLength(3);
    expect(bundle?.artifacts.map((artifact) => artifact.variantId)).toEqual(['1', '2', '3']);
    for (const artifact of bundle?.artifacts ?? []) {
      expect(artifact.path.startsWith('testOnly/')).toBe(true);
      const bytes = photoshop.readArtifact(artifact.path);
      expect(bytes).toBeDefined();
      const metadata = await sharp(bytes).metadata();
      expect(metadata.width).toBe(request.profile.output.width);
      expect(metadata.height).toBe(request.profile.output.height);
      expect(metadata.format).toBe(request.profile.output.format);
    }
    expect(evidence.artifacts.map((artifact) => artifact.path)).toEqual(bundle?.artifacts.map((artifact) => artifact.path));
    expect(photoshop.operations.map((operation) => operation.sequence)).toEqual([1]);
  });

  it.each([
    'mutationTimeout', 'cancelDuringChildSave', 'oneExportMissing', 'sourceChanged',
  ] as const)('exposes Photoshop failure %s through the schedule', async (scenario) => {
    const request = RenderRequestSchema.parse(loadFixture('render-request.valid.json'));
    const photoshop = new FakePhotoshop({ failures: { [scenario]: true } });
    await expect(photoshop.render(request, abort)).rejects.toMatchObject({ scenario });
  });

  it('supports an injected storage-failure schedule independently of operation failures', async () => {
    const request = RenderRequestSchema.parse(loadFixture('render-request.valid.json'));
    const photoshop = new FakePhotoshop({ storageFailures: { render: true } });
    await expect(photoshop.render(request, abort)).rejects.toMatchObject({ scenario: 'storage:render' });
  });

  it.each(['pass', 'revise', 'blocked'] as const)('returns a schema-valid intelligence decision in %s mode', async (mode) => {
    const intelligence = new FakeIntelligence({ mode });
    const evidence = loadFixture('evidence.pass.json');
    const manifest = EvidenceBundleManifestSchema.parse(loadFixture('manifest.pass.json'));
    const policy = ReviewPolicySchema.parse(loadFixture('policy.v1.json'));
    const decision = await intelligence.review({ evidence, manifest, policy }, 'model-remote-1', abort);
    expect(decision.variantChecks.map((check) => check.variantId)).toEqual(['1', '2', '3']);
    expect(decision.checks.map((check) => check.requirementId)).toEqual([...RUNTIME_REQUIREMENT_IDS]);
  });

  it('rejects invalid intelligence JSON instead of repairing it', async () => {
    const intelligence = new FakeIntelligence({ mode: 'invalidJson' });
    const evidence = loadFixture('evidence.pass.json');
    const manifest = EvidenceBundleManifestSchema.parse(loadFixture('manifest.pass.json'));
    const policy = ReviewPolicySchema.parse(loadFixture('policy.v1.json'));
    await expect(intelligence.review({ evidence, manifest, policy }, 'model-remote-1', abort)).rejects.toMatchObject({ scenario: 'invalidJson' });
    expect(intelligence.lastRawResponse).toContain('{"verdict"');
  });

  it('emits strictly increasing job event sequences and supports all failure scenarios', async () => {
    const spec = JobSpecSchema.parse(loadFixture('job.interactive.json'));
    const service = new FakeJobService();
    const events: JobEvent[] = [];
    service.subscribe(spec.jobId, (event) => events.push(event));
    await service.start(spec);
    await service.pause(spec.jobId);
    await service.resume(spec.jobId);
    await service.cancel(spec.jobId);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(events.every((event, index) => index === 0 || event.sequence > events[index - 1]!.sequence)).toBe(true);
  });

  it.each(['reviewOffline', 'reviewDigestMismatch'] as const)('blocks reviewer scenario %s', async (scenario) => {
    const spec = JobSpecSchema.parse(loadFixture('job.interactive.json'));
    const service = new FakeJobService({ failures: { [scenario]: true } });
    await service.start(spec);
    await expect(service.visualReview(spec.jobId, spec.assets[0]!.assetId)).rejects.toMatchObject({ scenario });
  });

  it.each(['caseCollision', 'sourceChanged', 'crashBeforePublish'] as const)('blocks start scenario %s', async (scenario) => {
    const spec = JobSpecSchema.parse(loadFixture('job.interactive.json'));
    const service = new FakeJobService({ failures: { [scenario]: true } });
    await expect(service.start(spec)).rejects.toMatchObject({ scenario });
  });

  it('records a crash after publish before the database boundary', async () => {
    const spec = JobSpecSchema.parse(loadFixture('job.interactive.json'));
    const service = new FakeJobService({ failures: { crashAfterPublishBeforeDb: true } });
    await service.start(spec);
    expect(() => service.publish(spec.jobId)).toThrowError(/crashAfterPublishBeforeDb/);
    expect((await service.snapshot(spec.jobId)).state).toBe('completed');
  });

  it('keeps static and live setup fixtures distinct and marks paths test-only', async () => {
    const staticSetup = new FakeSetupService({ inspection: 'static' });
    const liveSetup = new FakeSetupService({ inspection: 'live' });
    const staticReport = await staticSetup.inspectTemplate('template.psd', abort);
    const liveReport = await liveSetup.inspectTemplate('template.psd', abort);
    expect(staticReport.evidenceStatus).toBe('staticCandidate');
    expect(liveReport.evidenceStatus).toBe('liveObserved');
    expect(staticReport.capabilities).toBeNull();
    expect(liveReport.capabilities).not.toBeNull();
    expect(staticReport.evidencePaths.every((path) => path.startsWith('testOnly/'))).toBe(true);
    expect(liveReport.evidencePaths.every((path) => path.startsWith('testOnly/'))).toBe(true);
    const proposal = await liveSetup.proposeConfiguration({ instruction: 'fixture', inspectionId: liveReport.inspectionId, modelProfileId: 'model-local-1' }, abort);
    expect(validateQualificationRequest({ schemaVersion: 1, inspection: liveReport, proposal, workingTemplatePath: 'template.psd', evidenceDirectory: 'testOnly/evidence' }).success).toBe(false);
  });

  it('keeps fixture helpers and registry paths explicitly test-only', () => {
    expect(testOnlyPath('assets/trace.json')).toBe('testOnly/assets/trace.json');
    expect(RUNTIME_REQUIREMENT_IDS).toHaveLength(15);
  });

  it('keeps the requirement registry and policy fixture consistent', () => {
    const registry = JSON.parse(readFileSync(resolve(process.cwd(), 'docs/qualification/requirements-v1.json'), 'utf8')) as {
      requirements: Array<Record<string, unknown>>;
    };
    const policy = ReviewPolicySchema.parse(loadFixture('policy.v1.json'));
    expect(registry.requirements.map((requirement) => requirement.id)).toEqual([...RUNTIME_REQUIREMENT_IDS]);
    expect(policy.requirements.map((requirement) => requirement.id)).toEqual([...RUNTIME_REQUIREMENT_IDS]);
    for (const requirement of registry.requirements) {
      expect(typeof requirement.implementationPath).toBe('string');
      expect(typeof requirement.automatedTest).toBe('string');
      expect(typeof requirement.liveQualificationEvidenceOwner).toBe('string');
    }
    expect(policy.requirements.every((requirement) => requirement.mandatory)).toBe(true);
    expect(policy.requirements.find((requirement) => requirement.id === 'VISUAL.QUALIFIED')?.evaluator).toBe('model');
  });
});
