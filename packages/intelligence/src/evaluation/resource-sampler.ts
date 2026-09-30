import { arch, freemem, platform, totalmem } from 'node:os';

const GiB = 1024 ** 3;
const sampleEdgeToleranceMs = 5_000;
const maxSampleGapMs = 10_000;
export type ProcessMeasurement = Readonly<{ pid: number; name: string; rssBytes: number; observed: boolean }>;
export type ResourceObservation = Readonly<{
  measuredAt: string;
  platform: NodeJS.Platform;
  architecture: string;
  physicalRamBytes: number;
  systemAvailableBytes: number;
  systemUsedBytes: number;
  processes: Readonly<{ model: ProcessMeasurement | null; photoshop: ProcessMeasurement | null; desktop: ProcessMeasurement | null }>;
  gpu: Readonly<{ kind: 'discrete'; totalVramBytes: number; freeVramBytes: number; usedVramBytes: number; offloadLayers: number }> |
    Readonly<{ kind: 'unified'; offloadLayers: number }> | Readonly<{ kind: 'none'; offloadLayers: 0 }> | null;
  windows: Readonly<{ commitLimitBytes: number; commitUsedBytes: number; pagefileTotalBytes: number; pagefileUsedBytes: number; pagingThrashObserved: boolean }> | null;
  workload: Readonly<{ photoshopDocumentOpen: boolean; representativePsdSha256: string; documentBytes: number; desktopActive: boolean; modelLoaded: boolean }> | null;
  source: 'host-partial' | 'measured' | 'synthetic';
}>;
export type ResourceLocks = Readonly<{
  plannerProfileId: string;
  reviewerProfileId: string;
  plannerQualificationSha256: string;
  reviewerQualificationSha256: string;
  artifactSha256: string;
  runtimeBuild: string;
  chatTemplateSha256: string;
  promptSha256: string;
  policySha256: string;
  contextTokens: number;
  cacheSettings: string;
  maxOutputTokens: number;
}>;
export type ResourceQualificationReport = Readonly<{
  status: 'passed' | 'blocked';
  releaseQualified: boolean;
  locks: ResourceLocks;
  observations: readonly ResourceObservation[];
  minimumAvailableRamBytes: number | null;
  minimumDiscreteGpuFreeBytes: number | null;
  reasons: readonly string[];
}>;

export function collectHostPartialSample(): ResourceObservation {
  const physicalRamBytes = totalmem();
  const systemAvailableBytes = freemem();
  return {
    measuredAt: new Date().toISOString(), platform: platform(), architecture: arch(), physicalRamBytes,
    systemAvailableBytes, systemUsedBytes: physicalRamBytes - systemAvailableBytes,
    processes: { model: { pid: process.pid, name: 'qualify-model-cli', rssBytes: process.memoryUsage().rss, observed: true }, photoshop: null, desktop: null },
    gpu: null, windows: null, workload: null, source: 'host-partial',
  };
}

export function evaluateResourceQualification(input: Readonly<{
  locks: ResourceLocks;
  observations: readonly ResourceObservation[];
  expectedPlatform: NodeJS.Platform;
  measurementWindow?: Readonly<{ startMs: number; endMs: number }>;
}>): ResourceQualificationReport {
  const reasons: string[] = [];
  const { locks, observations } = input;
  if (!locks.plannerProfileId || !locks.reviewerProfileId || !locks.runtimeBuild || !locks.cacheSettings ||
    !Number.isSafeInteger(locks.contextTokens) || locks.contextTokens <= 0 ||
    !Number.isSafeInteger(locks.maxOutputTokens) || locks.maxOutputTokens <= 0 ||
    ![locks.plannerQualificationSha256, locks.reviewerQualificationSha256, locks.artifactSha256, locks.chatTemplateSha256, locks.promptSha256, locks.policySha256].every((value) => /^[a-f0-9]{64}$/.test(value))) {
    reasons.push('LOCKS.INCOMPLETE');
  }
  if (!observations.length) reasons.push('RESOURCE.NO_MEASUREMENTS');
  const sampleTimes = observations.map((sample) => Date.parse(sample.measuredAt));
  if (sampleTimes.some((time, index) => !Number.isFinite(time) || (index > 0 && time <= sampleTimes[index - 1]!))) reasons.push('RESOURCE.SAMPLE_TIMES_NOT_MONOTONIC');
  const window = input.measurementWindow;
  if (!window || !Number.isFinite(window.startMs) || !Number.isFinite(window.endMs) || window.endMs < window.startMs) {
    reasons.push('RESOURCE.CORPUS_WINDOW_UNMEASURED');
  } else {
    const covered = sampleTimes.filter((time) => time >= window.startMs - sampleEdgeToleranceMs && time <= window.endMs + sampleEdgeToleranceMs);
    if (covered.length < 2 || covered[0]! > window.startMs + sampleEdgeToleranceMs || covered.at(-1)! < window.endMs - sampleEdgeToleranceMs) reasons.push('RESOURCE.CORPUS_WINDOW_UNMEASURED');
    if (covered.some((time, index) => index > 0 && time - covered[index - 1]! > maxSampleGapMs)) reasons.push('RESOURCE.SAMPLE_GAP_TOO_LARGE');
  }
  const ramReserve = observations.length ? Math.max(8 * GiB, Math.ceil(Math.max(...observations.map((sample) => sample.physicalRamBytes)) * 0.15)) : null;
  let gpuReserve: number | null = null;
  for (const [index, sample] of observations.entries()) {
    const prefix = `SAMPLE.${index}`;
    if (sample.source !== 'measured') reasons.push(`${prefix}.NOT_LIVE_MEASUREMENT`);
    if (sample.platform !== input.expectedPlatform) reasons.push(`${prefix}.PLATFORM_MISMATCH`);
    if (!sample.architecture || !Number.isFinite(Date.parse(sample.measuredAt))) reasons.push(`${prefix}.IDENTITY_MISSING`);
    if (!Number.isSafeInteger(sample.physicalRamBytes) || sample.physicalRamBytes <= 0 ||
      !Number.isSafeInteger(sample.systemAvailableBytes) || sample.systemAvailableBytes < 0 ||
      !Number.isSafeInteger(sample.systemUsedBytes) || sample.systemUsedBytes < 0 ||
      sample.systemAvailableBytes + sample.systemUsedBytes > sample.physicalRamBytes * 1.05) reasons.push(`${prefix}.RAM_INVALID`);
    if (ramReserve !== null && sample.systemAvailableBytes < ramReserve) reasons.push(`${prefix}.RAM_RESERVE_LOW`);
    for (const name of ['model', 'photoshop', 'desktop'] as const) {
      const processEntry = sample.processes[name];
      if (!processEntry || !processEntry.observed || !Number.isSafeInteger(processEntry.pid) || processEntry.pid <= 0 ||
        !Number.isSafeInteger(processEntry.rssBytes) || processEntry.rssBytes <= 0 || !processEntry.name) reasons.push(`${prefix}.${name.toUpperCase()}_PROCESS_MISSING`);
    }
    if (!sample.workload || !sample.workload.photoshopDocumentOpen || !sample.workload.desktopActive || !sample.workload.modelLoaded ||
      !/^[a-f0-9]{64}$/.test(sample.workload.representativePsdSha256) ||
      !Number.isSafeInteger(sample.workload.documentBytes) || sample.workload.documentBytes <= 0) reasons.push(`${prefix}.WORKLOAD_MISSING`);
    if (!sample.gpu) reasons.push(`${prefix}.GPU_EVIDENCE_MISSING`);
    else if (sample.gpu.kind === 'discrete') {
      const reserve = Math.max(2 * GiB, Math.ceil(sample.gpu.totalVramBytes * 0.1));
      gpuReserve = Math.max(gpuReserve ?? 0, reserve);
      if (!Number.isSafeInteger(sample.gpu.totalVramBytes) || sample.gpu.totalVramBytes <= 0 ||
        !Number.isSafeInteger(sample.gpu.freeVramBytes) || sample.gpu.freeVramBytes < 0 ||
        !Number.isSafeInteger(sample.gpu.usedVramBytes) || sample.gpu.usedVramBytes < 0 ||
        sample.gpu.freeVramBytes + sample.gpu.usedVramBytes > sample.gpu.totalVramBytes * 1.05 ||
        sample.gpu.freeVramBytes < reserve) reasons.push(`${prefix}.GPU_RESERVE_LOW_OR_INVALID`);
    } else if (!Number.isSafeInteger(sample.gpu.offloadLayers) || sample.gpu.offloadLayers < 0) reasons.push(`${prefix}.GPU_OFFLOAD_INVALID`);
    if (input.expectedPlatform === 'win32') {
      const windows = sample.windows;
      if (!windows || ![windows.commitLimitBytes, windows.commitUsedBytes, windows.pagefileTotalBytes, windows.pagefileUsedBytes].every((n) => Number.isSafeInteger(n) && n >= 0) ||
        windows.commitLimitBytes <= windows.commitUsedBytes || windows.pagefileTotalBytes < windows.pagefileUsedBytes || windows.pagingThrashObserved) reasons.push(`${prefix}.WINDOWS_PRESSURE_MISSING_OR_BAD`);
    }
  }
  const status = reasons.length ? 'blocked' : 'passed';
  return { status, releaseQualified: status === 'passed' && input.expectedPlatform === 'win32', locks,
    observations, minimumAvailableRamBytes: ramReserve, minimumDiscreteGpuFreeBytes: gpuReserve, reasons };
}
