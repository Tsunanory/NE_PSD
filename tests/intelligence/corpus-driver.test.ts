import { readFile, access, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { materializeCorpusFixture, wrapCorpusTransport, createCorpusDriver, verifyCorpusLock, type CorpusDescriptor } from '../../packages/intelligence/dist/evaluation/corpus-driver.js';
import { runCorpus } from '../../packages/intelligence/dist/evaluation/run-corpus.js';
import { admitCandidateTrial } from '../../packages/intelligence/dist/profiles/candidate-trial.js';
import { createCandidateTrialFixture } from './helpers/candidate-trial-fixture.js';
import type { CorpusCase } from '../../packages/intelligence/dist/evaluation/run-corpus.js';
import type { ModelTransport, TransportRequest, TransportResponse } from '../../packages/intelligence/dist/transport/model-transport.js';
import { parseAndValidateStrictJson } from '../../packages/intelligence/dist/validation/strict-json.js';

const root = resolve(import.meta.dirname, '../..');
const rows = async () => JSON.parse(await readFile(join(root, 'tests/intelligence/fixtures/acceptance-corpus.json'), 'utf8')) as CorpusCase[];

describe('bounded corpus fixture materialization', () => {
  it('loads all 64 fixed descriptors into isolated job-owned copies without editing fixture bytes', async () => {
    const cases = await rows();
    expect(cases).toHaveLength(64);
    for (const row of cases) {
      const source = await readFile(join(root, row.fixture));
      const fixture = await materializeCorpusFixture(row, root);
      try {
        expect(fixture.descriptor.id).toBe(row.id);
        expect(fixture.descriptor.role).toBe(row.role);
        if (fixture.bundleRoot) {
          expect(fixture.bundleRoot).toContain('ne-psd-corpus-');
          for (const [path, digest] of Object.entries(fixture.sourceDigests)) {
            const bytes = await readFile(join(fixture.bundleRoot, path));
            expect(digest).toMatch(/^[a-f0-9]{64}$/);
            expect(bytes.byteLength).toBeGreaterThan(0);
          }
        }
      } finally {
        await fixture.cleanup();
      }
      expect(await readFile(join(root, row.fixture))).toEqual(source);
      if (fixture.bundleRoot) await expect(access(fixture.bundleRoot)).rejects.toThrow();
    }
  }, 30000);
  it('rejects descriptor binding changes, traversal, and malformed JSON before adapter invocation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ne-psd-corpus-bad-'));
    const path = join(directory, 'tests/intelligence/fixtures/acceptance/cases/BAD/descriptor.json');
    try {
      await mkdir(dirname(path), { recursive: true });
      const row = { id: 'BAD', role: 'planner', fixture: 'tests/intelligence/fixtures/acceptance/cases/BAD/descriptor.json' } as const;
      await writeFile(path, '{');
      await expect(materializeCorpusFixture(row, directory)).rejects.toThrow('CORPUS_FIXTURE_DESCRIPTOR_JSON');
      await writeFile(path, JSON.stringify({ schemaVersion: 1, foundationContractVersion: 1, id: 'OTHER', role: 'planner', mode: 'adapter', input: {} }));
      await expect(materializeCorpusFixture(row, directory)).rejects.toThrow('CORPUS_FIXTURE_DESCRIPTOR_BINDING');
      await expect(materializeCorpusFixture({ ...row, fixture: '../descriptor.json' }, directory)).rejects.toThrow('CORPUS_FIXTURE_DESCRIPTOR_PATH');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('records the transport call before applying a raw response fault to the real strict parser', async () => {
    let baseCalls = 0;
    let observedCalls = 0;
    const response: TransportResponse = { raw: Buffer.from('{"status":"proposed"}'), modelId: 'selected', finishReason: 'stop',
      usage: { inputTokens: 4, outputTokens: 2 }, providerRevision: null, sessionId: 'fresh' };
    const base: ModelTransport = { invoke: async () => { baseCalls++; return response; } };
    const descriptor = { schemaVersion: 1, foundationContractVersion: 1, id: 'AJ09', role: 'planner', mode: 'response-fault', input: {},
      visualBundle: null, preflightFault: null,
      responseFault: { stage: 'after-live-model-response', mutation: 'duplicate-keys', field: 'raw', value: null } } satisfies CorpusDescriptor;
    const corrupted = await wrapCorpusTransport(base, descriptor, () => { observedCalls++; }).invoke({} as TransportRequest);
    expect(baseCalls).toBe(1);
    expect(observedCalls).toBe(1);
    expect(() => parseAndValidateStrictJson(corrupted.raw, (value) => value)).toThrow();
  });
});

describe('pinned corpus lock', () => {
  it('rejects changed expectations before running any fixture', async () => {
    const original = await rows();
    const changed = structuredClone(original);
    (changed[0] as any).expected.status = 'blocked';
    await expect(verifyCorpusLock(root, changed)).rejects.toThrow('CORPUS_FIXTURE_LOCK_EXPECTATIONS_CHANGED');
  });
  it('rejects a changed descriptor even when the caller still supplies frozen rows', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ne-psd-lock-mutant-'));
    try {
      const files = [
        'docs/intelligence/qualification/visual-corpus-manifest.json',
        'tests/intelligence/fixtures/acceptance-corpus.json',
        'tests/intelligence/fixtures/acceptance/cases/PG01/descriptor.json',
      ];
      for (const path of files) { await mkdir(dirname(join(directory, path)), { recursive: true });
        await writeFile(join(directory, path), await readFile(join(root, path))); }
      const path = join(directory, files[2]!);
      const descriptor = JSON.parse(await readFile(path, 'utf8'));
      descriptor.input.instruction = 'changed but structurally valid';
      await writeFile(path, JSON.stringify(descriptor));
      await expect(verifyCorpusLock(directory, await rows())).rejects.toThrow('CORPUS_FIXTURE_LOCK_DESCRIPTOR_CHANGED');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

describe('C-owned corpus host dispatch', () => {
  it('runs fixed cases through planner, diagnostic and reviewer with independent fake replies', async () => {
    const plannerFixture = await createCandidateTrialFixture('planner');
    const reviewerFixture = await createCandidateTrialFixture('reviewer');
    try {
      const measured = (fixture: Awaited<ReturnType<typeof createCandidateTrialFixture>>) => ({ ...fixture.counter,
        countPacket: (request: TransportRequest) => ({ systemTokens: 10,
          userTokens: Math.floor((typeof request.messages[1].content === 'string'
            ? request.messages[1].content.length : (request.messages[1].content.find((part: any) => part.type === 'text') as any)?.text?.length ?? 0) / 24),
          schemaTokens: 10, wrapperTokens: 10,
          imageTokens: Array.isArray(request.messages[1].content) ? request.messages[1].content.filter((part: any) => part.type === 'image').length * 10 : 0 }),
      });
      const planner = await admitCandidateTrial({ manifestPath: plannerFixture.manifestPath, expectedPlatform: process.platform,
        probe: plannerFixture.probe, counter: measured(plannerFixture), role: 'planner' });
      const reviewer = await admitCandidateTrial({ manifestPath: reviewerFixture.manifestPath, expectedPlatform: process.platform,
        probe: reviewerFixture.probe, counter: measured(reviewerFixture), role: 'reviewer' });
      const fixed = new Map<string, CorpusDescriptor>();
      for (const row of await rows()) fixed.set(row.id, JSON.parse(await readFile(join(root, row.fixture), 'utf8')));
      const transport: ModelTransport = { async invoke(request) {
        const binding = JSON.parse(typeof request.messages[1].content === 'string' ? request.messages[1].content : request.messages[1].content[0]!.text);
        const id = request.sessionId.startsWith('corpus-') ? request.sessionId.slice(7) :
          binding.requestId?.startsWith('diagnostic-') ? binding.requestId.slice(11) : binding.jobId?.slice(7);
        const descriptor = fixed.get(id);
        if (!descriptor) throw new Error(`INDEPENDENT_FIXTURE_MISSING:${id}`);
        let answer: any;
        if (descriptor.role === 'planner') answer = structuredClone((descriptor.input as any).candidateProposal);
        else if (descriptor.role === 'diagnostic') {
          const input = JSON.parse(request.messages[1].content as string);
          answer = { schemaVersion: 1, requestId: input.requestId, sessionId: input.sessionId,
            promptSha256: input.promptSha256, subjectId: input.subjectId, evidenceSha256: input.evidenceSha256,
            status: 'blocked', observations: ['Observed failure'], unknowns: ['Runtime state'],
            cause: { code: input.domainError.code, summary: 'Runtime state requires operator', evidenceRefs: input.evidenceRefs },
            actionCode: input.allowedActions.includes('OPERATOR_RECOVERY_REQUIRED') ? 'OPERATOR_RECOVERY_REQUIRED' : input.allowedActions[0],
            actionReason: 'No safe automatic action', evidenceRefs: input.evidenceRefs };
        } else {
          const input = (descriptor.input as any);
          const packet = request.messages[1].content;
          const user = JSON.parse(typeof packet === 'string' ? packet : (packet as any[])[0].text);
          const defect = (descriptor.visualBundle as any)?.seededDefect;
          const evidence = input.evidence;
          answer = { schemaVersion: 1, reviewId: user.reviewId, jobId: input.job.jobId, assetId: evidence.assetId,
            attempt: evidence.attempt, evidenceSha256: input.trustedState.sealedEvidenceSha256,
            sessionId: request.sessionId, promptSha256: input.policy.promptSha256, modelId: request.profile.modelId,
            modelProvenance: request.profile.provenance, reviewerVersion: reviewerFixture.probe.runtimeBuild,
            reviewPolicySha256: input.policy.policySha256, verdict: defect ? 'blocked' : 'pass',
            variantChecks: evidence.artifacts.map((artifact: any) => {
              const vision = input.manifest.visionInputs;
              const related = vision.filter((image: any) => image.role === 'source' ||
                (image.variantId === artifact.variantId && ['reference', 'detail'].includes(image.role)));
              return { variantId: artifact.variantId,
                verdict: defect?.variantId === artifact.variantId ? 'fail' : 'pass',
                evidenceRefs: [artifact.path, ...related.map((image: any) => image.relativePath)],
                reason: `Synthetic variant ${artifact.variantId}: source and sealed reference compared with output details.` };
            }),
            checks: input.policy.requirements.map((requirement: any) => ({ requirementId: requirement.id,
              result: 'pass', evidenceRefs: [evidence.checks[0].evidencePath], reason: 'Sealed synthetic evidence' })),
            findings: defect ? [{ severity: defect.severity, code: defect.code,
              evidenceRefs: [evidence.artifacts.find((artifact: any) => artifact.variantId === defect.variantId).path],
              message: defect.expectedVisualFact }] : [] };
        }
        return { raw: Buffer.from(JSON.stringify(answer)), modelId: request.profile.modelId, finishReason: 'stop',
          usage: { inputTokens: 100, outputTokens: 100 }, providerRevision: null, sessionId: request.sessionId };
      } };
      const driver = createCorpusDriver({ repositoryRoot: root,
        planner: { ...planner, manifestPath: plannerFixture.manifestPath },
        reviewer: { ...reviewer, manifestPath: reviewerFixture.manifestPath }, transport, deadlineMs: 300000 });
      const report = await runCorpus({ cases: await rows(), repetitions: 3, profiles: { planner: planner.profile.profileId,
        reviewer: reviewer.profile.profileId }, provenance: 'synthetic', deadlineMs: 300000,
        signal: new AbortController().signal, ...driver });
      expect(report.status, report.trials.filter((trial) => !trial.passed && trial.repetition === 1).map((trial) => `${trial.caseId}[${trial.failureCode}]:${trial.reasons.join(',')}`).join('\n'))
        .toBe('passed');
      expect(report.corpusSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(report.fixtureManifestSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(report.trials).toHaveLength(192);
      expect(report.falseAccepts).toBe(0);
      expect(report.falseBlocks).toBe(0);
    } finally { await plannerFixture.close(); await reviewerFixture.close(); }
  }, 120000);
});
