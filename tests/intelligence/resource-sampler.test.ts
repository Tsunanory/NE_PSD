import { describe, expect, it } from 'vitest';
import { collectHostPartialSample, evaluateResourceQualification, type ResourceLocks, type ResourceObservation } from '../../packages/intelligence/dist/evaluation/resource-sampler.js';

const GiB = 1024 ** 3;
const locks: ResourceLocks = { plannerProfileId: 'planner-A', reviewerProfileId: 'reviewer-B',
  plannerQualificationSha256: 'e'.repeat(64), reviewerQualificationSha256: 'f'.repeat(64), artifactSha256: 'a'.repeat(64),
  runtimeBuild: 'runtime-v1', chatTemplateSha256: 'b'.repeat(64), promptSha256: 'c'.repeat(64), policySha256: 'd'.repeat(64),
  contextTokens: 8192, maxOutputTokens: 1024, cacheSettings: 'f16/context8192' };
const sample = (overrides: Partial<ResourceObservation> = {}): ResourceObservation => ({
  measuredAt: '2026-09-30T00:00:00.000Z', platform: 'win32', architecture: 'x64', physicalRamBytes: 64 * GiB,
  systemAvailableBytes: 12 * GiB, systemUsedBytes: 52 * GiB,
  processes: { model: { pid: 12, name: 'model', rssBytes: 20 * GiB, observed: true },
    photoshop: { pid: 13, name: 'Photoshop', rssBytes: 5 * GiB, observed: true },
    desktop: { pid: 14, name: 'NE_PSD', rssBytes: 1 * GiB, observed: true } },
  gpu: { kind: 'discrete', totalVramBytes: 24 * GiB, freeVramBytes: 4 * GiB, usedVramBytes: 20 * GiB, offloadLayers: 60 },
  windows: { commitLimitBytes: 90 * GiB, commitUsedBytes: 60 * GiB, pagefileTotalBytes: 26 * GiB, pagefileUsedBytes: 3 * GiB, pagingThrashObserved: false },
  workload: { photoshopDocumentOpen: true, representativePsdSha256: 'e'.repeat(64), documentBytes: 10_000_000, desktopActive: true, modelLoaded: true },
  source: 'synthetic', ...overrides,
});

describe('resource qualification gates', () => {
  it('marks partial host sample and synthetic measurements non-qualifying', () => {
    const partial = collectHostPartialSample();
    expect(partial.source).toBe('host-partial');
    expect(partial.processes.photoshop).toBeNull();
    const report = evaluateResourceQualification({ locks, observations: [sample()], expectedPlatform: 'win32' });
    expect(report.status).toBe('blocked');
    expect(report.releaseQualified).toBe(false);
    expect(report.reasons).toContain('SAMPLE.0.NOT_LIVE_MEASUREMENT');
    expect(report.minimumAvailableRamBytes).toBe(Math.ceil(64 * GiB * 0.15));
    expect(report.minimumDiscreteGpuFreeBytes).toBe(Math.ceil(24 * GiB * 0.1));
    expect(report.reasons).toContain('RESOURCE.CORPUS_WINDOW_UNMEASURED');
  });
  it('enforces RAM, discrete GPU, Windows commit/pagefile and positive Photoshop workload evidence', () => {
    const low = sample({ systemAvailableBytes: 7 * GiB, systemUsedBytes: 57 * GiB,
      gpu: { kind: 'discrete', totalVramBytes: 24 * GiB, freeVramBytes: 1 * GiB, usedVramBytes: 23 * GiB, offloadLayers: 60 },
      windows: null, workload: null, processes: { model: null, photoshop: null, desktop: null } });
    const result = evaluateResourceQualification({ locks, observations: [low], expectedPlatform: 'win32' });
    expect(result.reasons).toEqual(expect.arrayContaining(['SAMPLE.0.RAM_RESERVE_LOW', 'SAMPLE.0.GPU_RESERVE_LOW_OR_INVALID',
      'SAMPLE.0.WINDOWS_PRESSURE_MISSING_OR_BAD', 'SAMPLE.0.WORKLOAD_MISSING', 'SAMPLE.0.PHOTOSHOP_PROCESS_MISSING']));
  });
  it('does not double-count unified GPU memory and never treats Mac evidence as Windows release proof', () => {
    const mac = sample({ platform: 'darwin', gpu: { kind: 'unified', offloadLayers: 40 }, windows: null });
    const report = evaluateResourceQualification({ locks, observations: [mac], expectedPlatform: 'darwin' });
    expect(report.minimumDiscreteGpuFreeBytes).toBeNull();
    expect(report.releaseQualified).toBe(false);
    expect(report.reasons).not.toContain('SAMPLE.0.GPU_RESERVE_LOW_OR_INVALID');
  });
  it('requires monotonic samples spanning the corpus without unobserved gaps', () => {
    const startMs = Date.parse('2026-09-30T00:00:00.000Z');
    const at = (offsetMs: number) => sample({ source: 'measured', measuredAt: new Date(startMs + offsetMs).toISOString() });
    const measurementWindow = { startMs, endMs: startMs + 20_000 };
    const evaluate = (observations: ResourceObservation[]) => evaluateResourceQualification({ locks, observations, expectedPlatform: 'win32', measurementWindow });
    expect(evaluate([0, 5_000, 10_000, 15_000, 20_000].map(at)).releaseQualified).toBe(true);
    expect(evaluate([at(0), at(0), at(20_000)]).reasons).toContain('RESOURCE.SAMPLE_TIMES_NOT_MONOTONIC');
    expect(evaluate([at(0), at(5_000), at(10_000)]).reasons).toContain('RESOURCE.CORPUS_WINDOW_UNMEASURED');
    expect(evaluate([at(0), at(20_000)]).reasons).toContain('RESOURCE.SAMPLE_GAP_TOO_LARGE');
    expect(evaluate([at(6_000), at(10_000), at(15_000), at(20_000)]).reasons).toContain('RESOURCE.CORPUS_WINDOW_UNMEASURED');
  });
});
