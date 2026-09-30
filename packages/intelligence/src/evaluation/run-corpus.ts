import { isDeepStrictEqual } from 'node:util';

export type CorpusGroup = 'planner-grounding' | 'runtime-review' | 'adversarial-json' | 'failure-context-capability' | 'diagnostic-visual';
export type CorpusRole = 'planner' | 'reviewer' | 'diagnostic';
export type PathAssertion = Readonly<{ path: string; value: unknown }>;
export type CorpusCase = Readonly<{
  id: string;
  group: CorpusGroup;
  role: CorpusRole;
  fixture: string;
  expected: Readonly<{
    kind: 'admitted' | 'rejected' | 'preflight-rejected';
    status?: string;
    failureCode?: string;
    requiredPaths?: readonly PathAssertion[];
    prohibitedPaths?: readonly PathAssertion[];
    criticalDefect?: boolean;
  }>;
  evidenceRequirement: string;
}>;
export type CaseOutcome = Readonly<{
  admitted: boolean;
  status: string | null;
  value: unknown;
  failureCode: string | null;
  profileId: string;
  modelCalls: number;
  outputTokens: number | null;
  evidenceRefs: readonly string[];
  observedDefects: readonly string[];
  validation: Readonly<{ schemaValid: boolean; bindingValid: boolean; checkSetComplete: boolean; prohibitedAction: boolean }>;
}>;
export type CorpusTrial = Readonly<{
  caseId: string;
  repetition: number;
  role: CorpusRole;
  profileId: string;
  cold: boolean;
  durationMs: number;
  modelCalls: number;
  outputTokens: number | null;
  admitted: boolean;
  status: string | null;
  failureCode: string | null;
  passed: boolean;
  reasons: readonly string[];
}>;
export type LatencyStats = Readonly<{ count: number; medianMs: number | null; p95Ms: number | null; worstMs: number | null }>;
export type CorpusReport = Readonly<{
  status: 'passed' | 'failed';
  provenance: 'synthetic' | 'live';
  corpusSha256: string | null;
  fixtureManifestSha256: string | null;
  plannerProfileId: string;
  reviewerProfileId: string;
  cases: 64;
  repetitions: 3;
  trials: readonly CorpusTrial[];
  modelCalls: number;
  preflightRejections: number;
  falseAccepts: number;
  falseBlocks: number;
  defectMisses: number;
  cold: LatencyStats;
  warm: LatencyStats;
  deadlineMs: number;
  p95TargetMs: number;
  reasons: readonly string[];
}>;
export type RunCorpusOptions = Readonly<{
  cases: readonly CorpusCase[];
  repetitions: 3;
  profiles: Readonly<{ planner: string; reviewer: string }>;
  provenance: 'synthetic' | 'live';
  deadlineMs: number;
  signal: AbortSignal;
  corpusLock?: (cases: readonly CorpusCase[]) => Promise<Readonly<{ corpusSha256: string; fixtureManifestSha256: string }>>;
  preflight: (row: CorpusCase, profileId: string, signal: AbortSignal) => Promise<string | null> | string | null;
  invoke: (row: CorpusCase, profileId: string, signal: AbortSignal, recordModelCall: () => void) => Promise<CaseOutcome>;
}>;

const counts: Readonly<Record<CorpusGroup, number>> = {
  'planner-grounding': 12, 'runtime-review': 20, 'adversarial-json': 12, 'failure-context-capability': 12, 'diagnostic-visual': 8,
};
const groups = Object.keys(counts) as CorpusGroup[];
function validateCase(row: CorpusCase): void {
  if (!row || typeof row.id !== 'string' || !row.id || typeof row.fixture !== 'string' || !row.fixture ||
    row.fixture.startsWith('/') || /^[A-Za-z]:/.test(row.fixture) || row.fixture.includes('\\') ||
    row.fixture.split('/').some((part) => part === '..' || part === '.' || part === '') ||
    !groups.includes(row.group) || !['planner', 'reviewer', 'diagnostic'].includes(row.role) ||
    !row.expected || !['admitted', 'rejected', 'preflight-rejected'].includes(row.expected.kind) ||
    typeof row.evidenceRequirement !== 'string' || !row.evidenceRequirement ||
    (row.expected.kind === 'admitted' && !row.expected.status) ||
    (row.expected.kind !== 'admitted' && !row.expected.failureCode) ||
    (row.expected.kind === 'preflight-rejected' && row.expected.criticalDefect)) throw new Error(`INVALID_CORPUS_CASE:${row?.id ?? 'unknown'}`);
  for (const assertion of [...row.expected.requiredPaths ?? [], ...row.expected.prohibitedPaths ?? []]) {
    if (!assertion.path.startsWith('/') || assertion.path.includes('//')) throw new Error(`INVALID_CORPUS_PATH:${row.id}`);
  }
}
export function validateCorpus(rows: readonly CorpusCase[]): void {
  if (!Array.isArray(rows) || rows.length !== 64) throw new Error('CORPUS_REQUIRES_64_CASES');
  const ids = new Set<string>();
  for (const row of rows) {
    validateCase(row);
    if (ids.has(row.id)) throw new Error(`DUPLICATE_CORPUS_CASE:${row.id}`);
    ids.add(row.id);
  }
  for (const group of groups) if (rows.filter((row) => row.group === group).length !== counts[group]) throw new Error(`CORPUS_GROUP_COUNT:${group}`);
}
function atPath(value: unknown, pointer: string): unknown {
  let current = value;
  for (const part of pointer.slice(1).split('/').map((item) => item.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (!current || typeof current !== 'object' || !(part in current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
function stats(values: readonly number[]): LatencyStats {
  if (!values.length) return { count: 0, medianMs: null, p95Ms: null, worstMs: null };
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted.length % 2 ? sorted[Math.floor(sorted.length / 2)]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
  return { count: sorted.length, medianMs: median, p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1]!, worstMs: sorted.at(-1)! };
}
function check(row: CorpusCase, outcome: CaseOutcome | null, preflightCode: string | null, profileId: string): string[] {
  const reasons: string[] = [];
  const expected = row.expected;
  if (expected.kind === 'preflight-rejected') {
    if (preflightCode !== expected.failureCode) reasons.push('PREFLIGHT_CODE_MISMATCH');
    if (outcome !== null) reasons.push('PREFLIGHT_INVOKED');
    return reasons;
  }
  if (preflightCode !== null) return ['UNEXPECTED_PREFLIGHT_REJECTION'];
  if (!outcome) return ['MISSING_OUTCOME'];
  if (!outcome.validation || !Array.isArray(outcome.evidenceRefs) || !Array.isArray(outcome.observedDefects) ||
    typeof outcome.profileId !== 'string' || typeof outcome.admitted !== 'boolean') return ['MALFORMED_ADAPTER_OUTCOME'];
  if (outcome.profileId !== profileId) reasons.push('PROFILE_SUBSTITUTION');
  if (!Number.isSafeInteger(outcome.modelCalls) || outcome.modelCalls < 0 || outcome.modelCalls > 1) reasons.push('MODEL_CALL_COUNT_INVALID');
  if (outcome.validation.prohibitedAction) reasons.push('PROHIBITED_ACTION');
  if (expected.kind === 'admitted') {
    if (!outcome.admitted) reasons.push('FALSE_BLOCK');
    if (!outcome.validation.schemaValid || !outcome.validation.bindingValid || !outcome.validation.checkSetComplete) reasons.push('STRUCTURED_VALIDATION_FAILED');
    if (outcome.status !== expected.status) reasons.push('STATUS_MISMATCH');
  } else {
    if (outcome.admitted) reasons.push('FALSE_ACCEPT');
    if (outcome.failureCode !== expected.failureCode) reasons.push('REJECTION_CODE_MISMATCH');
  }
  if (!outcome.evidenceRefs.includes(row.evidenceRequirement)) reasons.push('EVIDENCE_MISSING');
  for (const assertion of expected.requiredPaths ?? []) if (!isDeepStrictEqual(atPath(outcome.value, assertion.path), assertion.value)) reasons.push(`REQUIRED_PATH:${assertion.path}`);
  for (const assertion of expected.prohibitedPaths ?? []) if (isDeepStrictEqual(atPath(outcome.value, assertion.path), assertion.value)) reasons.push(`PROHIBITED_PATH:${assertion.path}`);
  if (expected.criticalDefect && !outcome.observedDefects.includes(row.id)) reasons.push('CRITICAL_DEFECT_MISSED');
  return reasons;
}

export async function runCorpus(options: RunCorpusOptions): Promise<CorpusReport> {
  validateCorpus(options.cases);
  const lock = options.corpusLock ? await options.corpusLock(options.cases) : null;
  if (options.provenance === 'live' && !lock) throw new Error('TRUSTED_CORPUS_LOCK_REQUIRED');
  if (options.repetitions !== 3 || !options.profiles.planner || !options.profiles.reviewer ||
    !Number.isSafeInteger(options.deadlineMs) || options.deadlineMs <= 0) throw new Error('INVALID_CORPUS_CONFIGURATION');
  const trials: CorpusTrial[] = [];
  const seenProfiles = new Set<string>();
  const reasons: string[] = [];
  let modelCalls = 0;
  let preflightRejections = 0;
  let falseAccepts = 0;
  let falseBlocks = 0;
  let defectMisses = 0;
  for (let repetition = 1; repetition <= 3; repetition++) for (const row of options.cases) {
    if (options.signal.aborted) throw new DOMException('Corpus evaluation aborted', 'AbortError');
    const profileId = row.role === 'reviewer' ? options.profiles.reviewer : options.profiles.planner;
    const cold = !seenProfiles.has(profileId);
    const start = performance.now();
    let preflightCode: string | null = null;
    let outcome: CaseOutcome | null = null;
    let exception: string | null = null;
    let observedCalls = 0;
    let invocationClosed = false;
    const controller = new AbortController();
    let rejectAbort!: (error: Error) => void;
    const abort = () => { controller.abort(); rejectAbort(new Error('MODEL_REQUEST_ABORTED')); };
    const cancellation = new Promise<never>((_, reject) => { rejectAbort = reject; });
    options.signal.addEventListener('abort', abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('MODEL_REQUEST_TIMEOUT')); }, options.deadlineMs);
    });
    const bounded = <T>(work: Promise<T>): Promise<T> => Promise.race([work, timeout, cancellation]);
    const recordModelCall = () => {
      if (invocationClosed) throw new Error('LATE_MODEL_CALL');
      observedCalls++;
    };
    try {
      preflightCode = await bounded(Promise.resolve().then(() => options.preflight(row, profileId, controller.signal)));
      if (preflightCode !== null) preflightRejections++;
      else {
        seenProfiles.add(profileId);
        outcome = await bounded(Promise.resolve().then(() => options.invoke(row, profileId, controller.signal, recordModelCall)));
      }
      if (controller.signal.aborted || options.signal.aborted) throw new Error('MODEL_REQUEST_ABORTED');
    } catch (error) { exception = error instanceof Error ? error.message : String(error); }
    finally {
      invocationClosed = true;
      if (timer) clearTimeout(timer);
      options.signal.removeEventListener('abort', abort);
      controller.abort();
    }
    const durationMs = performance.now() - start;
    const trialReasons = check(row, outcome, preflightCode, profileId);
    if (outcome && outcome.modelCalls !== observedCalls) trialReasons.push('MODEL_CALL_OBSERVATION_MISMATCH');
    if (preflightCode === null && observedCalls !== 1) trialReasons.push('MODEL_CALL_REQUIRED');
    if (observedCalls > 1) trialReasons.push('MODEL_CALL_BUDGET_EXCEEDED');
    if (exception) trialReasons.push(`INVOCATION_ERROR:${exception}`);
    if (durationMs > options.deadlineMs) trialReasons.push('DEADLINE_EXCEEDED');
    const calls = observedCalls;
    modelCalls += calls;
    if (trialReasons.includes('FALSE_ACCEPT')) falseAccepts++;
    if (trialReasons.includes('FALSE_BLOCK') || trialReasons.includes('UNEXPECTED_PREFLIGHT_REJECTION')) falseBlocks++;
    if (trialReasons.includes('CRITICAL_DEFECT_MISSED')) defectMisses++;
    trials.push({ caseId: row.id, repetition, role: row.role, profileId, cold, durationMs, modelCalls: calls,
      outputTokens: outcome?.outputTokens ?? null, admitted: outcome?.admitted ?? false, status: outcome?.status ?? null,
      failureCode: outcome?.failureCode ?? preflightCode, passed: trialReasons.length === 0, reasons: trialReasons });
  }
  if (modelCalls > 192) reasons.push('MODEL_CALL_BUDGET_EXCEEDED');
  if (trials.length !== 192) reasons.push('TRIAL_COUNT_INVALID');
  const called = trials.filter((trial) => trial.modelCalls > 0);
  const coldStats = stats(called.filter((trial) => trial.cold).map((trial) => trial.durationMs));
  const warmStats = stats(called.filter((trial) => !trial.cold).map((trial) => trial.durationMs));
  if (coldStats.worstMs !== null && coldStats.worstMs > options.deadlineMs) reasons.push('COLD_DEADLINE_EXCEEDED');
  if (warmStats.worstMs !== null && warmStats.worstMs > options.deadlineMs) reasons.push('WARM_DEADLINE_EXCEEDED');
  if (warmStats.p95Ms !== null && warmStats.p95Ms >= options.deadlineMs * 0.8) reasons.push('WARM_P95_MARGIN_MISSED');
  return { status: trials.every((trial) => trial.passed) && reasons.length === 0 ? 'passed' : 'failed', provenance: options.provenance,
    corpusSha256: lock?.corpusSha256 ?? null, fixtureManifestSha256: lock?.fixtureManifestSha256 ?? null,
    plannerProfileId: options.profiles.planner, reviewerProfileId: options.profiles.reviewer, cases: 64, repetitions: 3,
    trials, modelCalls, preflightRejections, falseAccepts, falseBlocks, defectMisses,
    cold: coldStats, warm: warmStats, deadlineMs: options.deadlineMs, p95TargetMs: options.deadlineMs * 0.8, reasons };
}
