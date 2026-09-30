import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Bytes, sha256Json } from '@ne-psd/contracts';
import { runCorpus, validateCorpus, type CaseOutcome, type CorpusCase, type CorpusGroup } from '../../packages/intelligence/dist/evaluation/run-corpus.js';
import { qualifyModel } from '../../packages/intelligence/dist/cli/qualify-model.js';

const groups: readonly [CorpusGroup, number][] = [
  ['planner-grounding', 12], ['runtime-review', 20], ['adversarial-json', 12], ['failure-context-capability', 12], ['diagnostic-visual', 8],
];
function rows(): CorpusCase[] {
  return groups.flatMap(([group, count]) => Array.from({ length: count }, (_, index) => {
    const id = `${group}-${index + 1}`;
    const kind = index === 0 ? 'preflight-rejected' : index === 1 ? 'rejected' : 'admitted';
    return { id, group, role: group === 'runtime-review' ? 'reviewer' : 'planner', fixture: `tests/intelligence/fixtures/acceptance/${id}.json`,
      expected: { kind, ...(kind === 'admitted' ? { status: 'pass', requiredPaths: [{ path: '/decision/status', value: 'pass' }],
        prohibitedPaths: [{ path: '/decision/executableAction', value: true }], criticalDefect: index === 2 } : { failureCode: kind === 'preflight-rejected' ? 'MISSING_EVIDENCE' : 'INVALID_RESPONSE' }) },
      evidenceRequirement: `evidence:${id}` } satisfies CorpusCase;
  }));
}
function outcome(row: CorpusCase, profileId: string): CaseOutcome {
  return { admitted: row.expected.kind === 'admitted', status: row.expected.kind === 'admitted' ? 'pass' : null,
    value: { decision: { status: 'pass', executableAction: false } }, failureCode: row.expected.kind === 'rejected' ? row.expected.failureCode! : null,
    profileId, modelCalls: 1, outputTokens: 12, evidenceRefs: [row.evidenceRequirement], observedDefects: row.expected.criticalDefect ? [row.id] : [],
    validation: { schemaValid: true, bindingValid: true, checkSetComplete: true, prohibitedAction: false } };
}
const options = (cases: readonly CorpusCase[]) => ({ cases, repetitions: 3 as const, profiles: { planner: 'planner-A', reviewer: 'reviewer-B' },
  provenance: 'synthetic' as const, deadlineMs: 1000, signal: new AbortController().signal,
  preflight: (row: CorpusCase) => row.expected.kind === 'preflight-rejected' ? 'MISSING_EVIDENCE' : null,
  invoke: async (row: CorpusCase, profileId: string, _signal: AbortSignal, recordModelCall: () => void) => { recordModelCall(); return outcome(row, profileId); } });

describe('fixed corpus harness with synthetic adapter', () => {
  it('runs 64 fixed rows three times with explicit role routing, no preflight calls, and structured assertions', async () => {
    const report = await runCorpus(options(rows()));
    expect(report.status).toBe('passed');
    expect(report.provenance).toBe('synthetic');
    expect(report.trials).toHaveLength(192);
    expect(report.preflightRejections).toBe(15);
    expect(report.modelCalls).toBe(177);
    expect(report.trials.filter((trial) => trial.role === 'reviewer').every((trial) => trial.profileId === 'reviewer-B')).toBe(true);
    expect(report.trials.filter((trial) => trial.failureCode === 'MISSING_EVIDENCE').every((trial) => trial.modelCalls === 0)).toBe(true);
    expect(report.cold.count).toBe(2);
    expect(report.warm.count).toBe(175);
  });
  it('rejects missing group rows, duplicates, false blocks, and undetected critical defects', async () => {
    expect(() => validateCorpus(rows().slice(1))).toThrow('CORPUS_REQUIRES_64_CASES');
    const duplicate = rows(); duplicate[1] = duplicate[0]!;
    expect(() => validateCorpus(duplicate)).toThrow('DUPLICATE_CORPUS_CASE');
    const r = rows();
    const run = options(r);
    const report = await runCorpus({ ...run, invoke: async (row, profileId, _signal, recordModelCall) => {
      recordModelCall();
      const base = outcome(row, profileId);
      if (row.id === 'planner-grounding-2') return { ...base, admitted: true, failureCode: null };
      if (row.id === 'planner-grounding-3') return { ...base, admitted: false, observedDefects: [] };
      return base;
    } });
    expect(report.status).toBe('failed');
    expect(report.falseAccepts).toBe(3);
    expect(report.falseBlocks).toBe(3);
    expect(report.defectMisses).toBe(3);
  });
  it('catches unobserved calls and profile substitution', async () => {
    const run = options(rows());
    const report = await runCorpus({ ...run, invoke: async (row, profileId, _signal, recordModelCall) => {
      if (row.id !== 'planner-grounding-3') recordModelCall();
      return row.id === 'planner-grounding-4' ? { ...outcome(row, profileId), profileId: 'fallback' } : outcome(row, profileId);
    } });
    expect(report.status).toBe('failed');
    expect(report.trials.find((trial) => trial.caseId === 'planner-grounding-3')?.reasons).toContain('MODEL_CALL_REQUIRED');
    expect(report.trials.find((trial) => trial.caseId === 'planner-grounding-4')?.reasons).toContain('PROFILE_SUBSTITUTION');
  });
  it('rejects two actual model calls in one trial even when callback reports one', async () => {
    const report = await runCorpus({ ...options(rows()), invoke: async (row, profileId, _signal, recordModelCall) => {
      recordModelCall();
      if (row.id === 'planner-grounding-3') recordModelCall();
      return outcome(row, profileId);
    } });
    expect(report.status).toBe('failed');
    expect(report.trials.find((trial) => trial.caseId === 'planner-grounding-3')?.reasons).toContain('MODEL_CALL_BUDGET_EXCEEDED');
    expect(report.modelCalls).toBe(180);
  });
  it('bounds a hanging preflight inside the trial deadline without a model call', async () => {
    let calls = 0;
    const report = await runCorpus({ ...options(rows()), deadlineMs: 15,
      preflight: (row) => row.id === 'planner-grounding-1' ? new Promise<string | null>(() => undefined) :
        options(rows()).preflight(row, '', new AbortController().signal),
      invoke: async (row, profileId, _signal, recordModelCall) => { calls++; recordModelCall(); return outcome(row, profileId); } });
    const hung = report.trials.filter((trial) => trial.caseId === 'planner-grounding-1');
    expect(hung).toHaveLength(3);
    expect(hung.every((trial) => trial.modelCalls === 0 && trial.reasons.includes('INVOCATION_ERROR:MODEL_REQUEST_TIMEOUT'))).toBe(true);
    expect(calls).toBe(177);
    expect(report.status).toBe('failed');
  });
  it('aborts a hanging preflight promptly and propagates its signal', async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | null = null;
    let calls = 0;
    const task = runCorpus({ ...options(rows()), signal: controller.signal, deadlineMs: 1000,
      preflight: (_row, _profileId, signal) => { observedSignal = signal; return new Promise<string | null>(() => undefined); },
      invoke: async (row, profileId, _signal, recordModelCall) => { calls++; recordModelCall(); return outcome(row, profileId); } });
    setTimeout(() => controller.abort(), 5);
    await expect(task).rejects.toThrow(/aborted/i);
    expect(observedSignal?.aborted).toBe(true);
    expect(calls).toBe(0);
  });
  it('records fixture setup errors as failures rather than expected preflight rejections', async () => {
    const report = await runCorpus({ ...options(rows()),
      preflight: (row, profileId, signal) => row.id === 'planner-grounding-1'
        ? Promise.reject(new Error('CORPUS_FIXTURE_DESCRIPTOR_JSON')) : options(rows()).preflight(row, profileId, signal) });
    const broken = report.trials.filter((trial) => trial.caseId === 'planner-grounding-1');
    expect(report.status).toBe('failed');
    expect(broken.every((trial) => trial.reasons.includes('INVOCATION_ERROR:CORPUS_FIXTURE_DESCRIPTOR_JSON'))).toBe(true);
    expect(broken.every((trial) => trial.modelCalls === 0 && !trial.passed)).toBe(true);
  });
  it('blocks an injected qualification adapter when its corpus path is not the frozen corpus', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ne-psd-c5-'));
    try {
      const artifact = Buffer.from('license-free-synthetic-model-placeholder');
      const artifactSha256 = sha256Bytes(artifact);
      await writeFile(join(directory, 'artifact.bin'), artifact);
      const manifest = {
        profile: { profileId: 'synthetic-profile', provider: 'local-qwen', modelId: 'synthetic-model',
          provenance: { kind: 'local', artifactSha256, runtimeVersion: 'synthetic-runtime', chatTemplateSha256: 'b'.repeat(64) },
          endpoint: 'http://127.0.0.1:8080', quantization: 'Q4_K_M', contextTokens: 8192, maxOutputTokens: 1024,
          capabilities: { jsonSchema: true, vision: true, tools: false } },
        stage: 'artifactVerified', artifactVerified: true, runtimeQualified: false, evidencePaths: ['evidence.json'], errors: [], fixture: false,
        artifact: { sourceUrl: 'https://example.invalid/synthetic', repository: 'synthetic', revision: 'fixture-1', architecture: 'synthetic',
          parameters: 'synthetic', license: 'test-only', usageTerms: 'test-only', files: [{ path: 'artifact.bin', bytes: artifact.byteLength, sha256: artifactSha256 }],
          quantization: 'Q4_K_M', converterRevision: null, tokenizer: 'synthetic', chatTemplate: 'synthetic', runtimeBuild: 'synthetic-runtime',
          runtimeSettings: {}, shardManifestSha256: null, resources: { os: process.platform, hardware: 'synthetic', evidencePaths: [] } },
      };
      await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
      await writeFile(join(directory, 'corpus.json'), JSON.stringify(rows()));
      const reportPath = join(directory, 'report.json');
      const report = await qualifyModel({ profile: join(directory, 'manifest.json'), expectedPlatform: process.platform, corpus: join(directory, 'corpus.json'),
        repetitions: 3, withPhotoshop: true, report: reportPath }, {
        provenance: 'synthetic', deadlineMs: 1000,
        locks: { plannerProfileId: 'synthetic-profile', reviewerProfileId: 'synthetic-profile',
          plannerQualificationSha256: sha256Json(manifest), reviewerQualificationSha256: sha256Json(manifest), artifactSha256,
          runtimeBuild: 'synthetic-runtime', chatTemplateSha256: 'b'.repeat(64), promptSha256: 'c'.repeat(64), policySha256: 'd'.repeat(64),
          contextTokens: 8192, cacheSettings: 'synthetic', maxOutputTokens: 1024 },
        probe: async () => ({ profileId: 'synthetic-profile', modelId: 'synthetic-model', artifactSha256,
          chatTemplateSha256: 'b'.repeat(64), tokenizerId: 'synthetic', runtimeBuild: 'synthetic-runtime',
          contextTokens: 8192, maxOutputTokens: 1024, jsonSchema: true, vision: true, imageInput: true,
          visionLimits: { maxImages: 13, maxWidth: 512, maxHeight: 384, maxPixels: 512 * 384, maxBytes: 1_000_000, maxDecodedBytes: 13 * 512 * 384 * 4 },
          qualifiedTransport: true, qualifiedSampling: true, evidenceRefs: ['synthetic-probe'] }),
        preflight: options(rows()).preflight,
        invoke: async (row, profileId, _signal, recordModelCall) => { recordModelCall(); return outcome(row, profileId); },
        beginMeasurement: async () => undefined,
        measure: async () => [],
      });
      expect(report.corpus).toBeNull();
      expect(report.status).toBe('blocked');
      expect(report.productionSelectable).toBe(false);
      expect(report.probes).toHaveLength(0);
      expect(report.reasons).toContain('CORPUS_INVALID:CORPUS_PATH_UNTRUSTED');
      expect(JSON.parse(await readFile(reportPath, 'utf8')).status).toBe('blocked');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
