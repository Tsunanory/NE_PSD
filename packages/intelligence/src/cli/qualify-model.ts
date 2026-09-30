import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ModelQualificationSchema } from '../profiles/qualification-schema.js';
import type { ModelQualification } from '../profiles/qualification-schema.js';
import { sha256Json } from '@ne-psd/contracts';
import { verifyModel } from './verify-model.js';
import { runCorpus, validateCorpus, type CorpusCase, type CorpusReport } from '../evaluation/run-corpus.js';
import { createCorpusDriver, verifyCorpusLock } from '../evaluation/corpus-driver.js';
import { admitCandidateTrial } from '../profiles/candidate-trial.js';
import type { QualifiedTokenCounter } from '../budget/qualified-token-count.js';
import type { ModelTransport } from '../transport/model-transport.js';
import { collectHostPartialSample, evaluateResourceQualification, type ResourceLocks, type ResourceObservation, type ResourceQualificationReport } from '../evaluation/resource-sampler.js';

export type QualificationOptions = Readonly<{
  profile: string;
  reviewerProfile?: string;
  expectedPlatform: NodeJS.Platform;
  corpus: string;
  repetitions: 3;
  withPhotoshop: boolean;
  runtimeAdapter?: 'qualified-runtime-bridge';
  report: string;
}>;
export type RuntimeProbe = Readonly<{
  profileId: string;
  modelId: string;
  artifactSha256: string;
  chatTemplateSha256: string;
  tokenizerId: string;
  runtimeBuild: string;
  contextTokens: number;
  maxOutputTokens: number;
  jsonSchema: boolean;
  vision: boolean;
  imageInput: boolean;
  visionLimits: null | Readonly<{ maxImages: number; maxWidth: number; maxHeight: number; maxPixels: number; maxBytes: number; maxDecodedBytes: number }>;
  qualifiedTransport: boolean;
  qualifiedSampling: boolean;
  evidenceRefs: readonly string[];
}>;
export type QualificationRuntime = Readonly<{
  provenance: 'live' | 'synthetic';
  deadlineMs: number;
  locks: ResourceLocks;
  probe: (profileId: string, role: 'planner' | 'reviewer') => Promise<RuntimeProbe>;
  transport: ModelTransport;
  counterFor: (profileId: string, role: 'planner' | 'reviewer') => QualifiedTokenCounter;
  beginMeasurement: (signal?: AbortSignal) => Promise<void>;
  measure: (signal?: AbortSignal) => Promise<readonly ResourceObservation[]>;
}>;
export type QualificationReport = Readonly<{
  status: 'trial-passed' | 'blocked';
  productionSelectable: false;
  platform: NodeJS.Platform;
  architecture: string;
  plannerProfileId: string | null;
  reviewerProfileId: string | null;
  corpus: CorpusReport | null;
  corpusSha256: string | null;
  fixtureManifestSha256: string | null;
  resources: ResourceQualificationReport | null;
  probes: readonly RuntimeProbe[];
  hostPartial: ResourceObservation;
  reasons: readonly string[];
}>;

async function persist(path: string, report: QualificationReport): Promise<QualificationReport> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(resolve(path), JSON.stringify(report, null, 2) + '\n');
  return report;
}
export async function qualifyModel(options: QualificationOptions, runtime?: QualificationRuntime, signal: AbortSignal = new AbortController().signal): Promise<QualificationReport> {
  const abortable = async <T>(work: Promise<T>): Promise<T> => {
    signal.throwIfAborted();
    let rejectAbort!: (reason: unknown) => void;
    const canceled = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const abort = () => rejectAbort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    try { return await Promise.race([work, canceled]); }
    finally { signal.removeEventListener('abort', abort); }
  };
  const hostPartial = collectHostPartialSample();
  const reasons: string[] = [];
  let plannerProfileId: string | null = null;
  let reviewerProfileId: string | null = null;
  let plannerQualification: ModelQualification | null = null;
  let reviewerQualification: ModelQualification | null = null;
  let corpus: CorpusReport | null = null;
  let resources: ResourceQualificationReport | null = null;
  const probes: RuntimeProbe[] = [];
  const finish = () => { signal.throwIfAborted(); return persist(options.report, { status: reasons.length === 0 && corpus?.status === 'passed' && resources?.releaseQualified === true ? 'trial-passed' : 'blocked',
    productionSelectable: false, platform: hostPartial.platform, architecture: hostPartial.architecture,
    plannerProfileId, reviewerProfileId, corpus, corpusSha256: corpus?.corpusSha256 ?? null, fixtureManifestSha256: corpus?.fixtureManifestSha256 ?? null, resources, probes, hostPartial, reasons }); };
  if (options.expectedPlatform !== hostPartial.platform) { reasons.push(`PLATFORM_MISMATCH:${options.expectedPlatform}:${hostPartial.platform}`); return finish(); }
  if (options.repetitions !== 3) { reasons.push('REPETITIONS_MUST_EQUAL_THREE'); return finish(); }
  if (!options.withPhotoshop) { reasons.push('PHOTOSHOP_WORKLOAD_REQUIRED'); return finish(); }
  try {
    const planner = ModelQualificationSchema.parse(JSON.parse(await readFile(resolve(options.profile), 'utf8')));
    const reviewer = options.reviewerProfile ? ModelQualificationSchema.parse(JSON.parse(await readFile(resolve(options.reviewerProfile), 'utf8'))) : planner;
    plannerQualification = planner;
    reviewerQualification = reviewer;
    plannerProfileId = planner.profile.profileId;
    reviewerProfileId = reviewer.profile.profileId;
    for (const [role, record, path] of [['PLANNER', planner, options.profile], ['REVIEWER', reviewer, options.reviewerProfile ?? options.profile]] as const) {
      const verified = await verifyModel({ manifest: path, expectedPlatform: options.expectedPlatform, artifactOnly: true });
      if (!verified.ok || !('artifactVerified' in verified) || !verified.artifactVerified) reasons.push(`${role}.ARTIFACT_UNVERIFIED`);
      if (record.fixture) reasons.push(`${role}.FIXTURE_PROFILE_FORBIDDEN`);
      if (record.runtimeQualified && record.stage !== 'runtimeQualified') reasons.push(`${role}.STAGE_INCONSISTENT`);
    }
    if (!reviewer.profile.capabilities.vision) reasons.push('REVIEWER.VISION_UNQUALIFIED');
    if (reviewer.profile.provider !== 'codex' && reviewer.profile.provenance.kind === 'remote') reasons.push('REVIEWER.PROVENANCE_UNQUALIFIED');
  } catch (error) { reasons.push(`PROFILE_LOAD_FAILED:${error instanceof Error ? error.message : String(error)}`); }
  let rows: CorpusCase[] = [];
  const repositoryRoot = resolve(dirname(resolve(options.corpus)), '../../..');
  try {
    rows = JSON.parse(await readFile(resolve(options.corpus), 'utf8')) as CorpusCase[];
    validateCorpus(rows);
    if (resolve(options.corpus) !== resolve(repositoryRoot, 'tests/intelligence/fixtures/acceptance-corpus.json')) throw new Error('CORPUS_PATH_UNTRUSTED');
    await verifyCorpusLock(repositoryRoot, rows);
  } catch (error) { reasons.push(`CORPUS_INVALID:${error instanceof Error ? error.message : String(error)}`); }
  if (reasons.length) return finish();
  if (!runtime && options.runtimeAdapter === 'qualified-runtime-bridge') {
    try {
      const packaged = await import(new URL('../transport/qualified-runtime-bridge.js', import.meta.url).href) as { createQualificationRuntime?: (value: QualificationOptions) => Promise<QualificationRuntime> };
      if (typeof packaged.createQualificationRuntime !== 'function') throw new Error('PACKAGED_ADAPTER_EXPORT_MISSING');
      runtime = await packaged.createQualificationRuntime(options);
    } catch (error) { reasons.push(`QUALIFIED_RUNTIME_BRIDGE_UNAVAILABLE:${error instanceof Error ? error.message : String(error)}`); return finish(); }
  }
  if (!runtime) { reasons.push('LIVE_RUNNER_AND_RESOURCE_PROBE_UNAVAILABLE'); return finish(); }
  if (runtime.provenance !== 'live') reasons.push('SYNTHETIC_RUNNER_CANNOT_QUALIFY');
  if (!plannerProfileId || !reviewerProfileId || !plannerQualification || !reviewerQualification ||
    runtime.locks.plannerProfileId !== plannerProfileId || runtime.locks.reviewerProfileId !== reviewerProfileId ||
    runtime.locks.plannerQualificationSha256 !== sha256Json(plannerQualification) ||
    runtime.locks.reviewerQualificationSha256 !== sha256Json(reviewerQualification) ||
    plannerQualification.profile.provenance.kind !== 'local' ||
    runtime.locks.artifactSha256 !== plannerQualification.profile.provenance.artifactSha256 ||
    runtime.locks.chatTemplateSha256 !== plannerQualification.profile.provenance.chatTemplateSha256 ||
    runtime.locks.runtimeBuild !== plannerQualification.artifact?.runtimeBuild ||
    runtime.locks.contextTokens !== plannerQualification.profile.contextTokens ||
    runtime.locks.maxOutputTokens !== plannerQualification.profile.maxOutputTokens) {
    reasons.push('ROLE_PROFILE_LOCK_MISMATCH'); return finish();
  }
  for (const [role, record] of [['planner', plannerQualification], ['reviewer', reviewerQualification]] as const) {
    try {
      const probe = await abortable(runtime.probe(record.profile.profileId, role));
      probes.push(probe);
      if (probe.profileId !== record.profile.profileId || probe.modelId !== record.profile.modelId ||
        record.profile.provenance.kind !== 'local' || probe.artifactSha256 !== record.profile.provenance.artifactSha256 ||
        probe.chatTemplateSha256 !== record.profile.provenance.chatTemplateSha256 ||
        probe.tokenizerId !== record.artifact?.tokenizer || probe.runtimeBuild !== record.artifact?.runtimeBuild ||
        probe.contextTokens < record.profile.contextTokens || probe.maxOutputTokens < record.profile.maxOutputTokens ||
        !probe.jsonSchema || !probe.qualifiedTransport || !probe.qualifiedSampling ||
        (role === 'reviewer' && (!probe.vision || !probe.imageInput || !probe.visionLimits ||
          !Object.values(probe.visionLimits).every((n) => Number.isSafeInteger(n) && n > 0))) ||
        probe.evidenceRefs.length === 0) reasons.push(`${role.toUpperCase()}.RUNTIME_PROBE_FAILED`);
    } catch (error) { reasons.push(`${role.toUpperCase()}.RUNTIME_PROBE_FAILED:${error instanceof Error ? error.message : String(error)}`); }
  }
  if (reasons.some((reason) => reason.includes('RUNTIME_PROBE_FAILED'))) return finish();
  let corpusStarted = 0;
  let corpusEnded = 0;
  try {
    const plannerCounter = runtime.counterFor(plannerProfileId, 'planner');
    const reviewerCounter = runtime.counterFor(reviewerProfileId, 'reviewer');
    const planner = await admitCandidateTrial({ manifestPath: options.profile, expectedPlatform: options.expectedPlatform, probe: probes[0]!, counter: plannerCounter, role: 'planner' });
    const reviewer = await admitCandidateTrial({ manifestPath: options.reviewerProfile ?? options.profile, expectedPlatform: options.expectedPlatform, probe: probes[1]!, counter: reviewerCounter, role: 'reviewer' });
    const driver = createCorpusDriver({ repositoryRoot, planner: { ...planner, manifestPath: options.profile }, reviewer: { ...reviewer, manifestPath: options.reviewerProfile ?? options.profile }, transport: runtime.transport, deadlineMs: runtime.deadlineMs });
    await abortable(runtime.beginMeasurement(signal));
    corpusStarted = Date.now();
    corpus = await runCorpus({ cases: rows, repetitions: 3, profiles: { planner: plannerProfileId, reviewer: reviewerProfileId },
      provenance: runtime.provenance, deadlineMs: runtime.deadlineMs, signal, corpusLock: driver.corpusLock!, preflight: driver.preflight, invoke: driver.invoke });
    if (corpus.status !== 'passed') reasons.push('CORPUS_FAILED');
  } catch (error) { signal.throwIfAborted(); reasons.push(`CORPUS_RUN_FAILED:${error instanceof Error ? error.message : String(error)}`); }
  finally { corpusEnded = Date.now(); }
  try {
    signal.throwIfAborted();
    resources = evaluateResourceQualification({ locks: runtime.locks, observations: await abortable(runtime.measure(signal)), expectedPlatform: options.expectedPlatform,
      measurementWindow: { startMs: corpusStarted, endMs: corpusEnded } });
    if (resources.status !== 'passed') reasons.push('RESOURCE_GATE_FAILED');
  } catch (error) { reasons.push(`RESOURCE_MEASUREMENT_FAILED:${error instanceof Error ? error.message : String(error)}`); }
  if (options.expectedPlatform !== 'win32') reasons.push('WINDOWS_RELEASE_EVIDENCE_REQUIRED');
  return finish();
}

function cliOptions(args: readonly string[]): QualificationOptions {
  const flags = new Map<string, string>();
  let withPhotoshop = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (flag === '--with-photoshop') { withPhotoshop = true; continue; }
    if (!flag.startsWith('--') || !args[index + 1] || args[index + 1]!.startsWith('--') || flags.has(flag)) throw new Error(`INVALID_ARGUMENT:${flag}`);
    flags.set(flag, args[++index]!);
  }
  const required = (flag: string) => { const value = flags.get(flag); if (!value) throw new Error(`MISSING_ARGUMENT:${flag}`); return value; };
  const known = new Set(['--profile', '--reviewer-profile', '--expected-platform', '--corpus', '--repetitions', '--report', '--runtime-adapter']);
  for (const flag of flags.keys()) if (!known.has(flag)) throw new Error(`UNKNOWN_ARGUMENT:${flag}`);
  if (flags.get('--runtime-adapter') && flags.get('--runtime-adapter') !== 'qualified-runtime-bridge') throw new Error('UNKNOWN_RUNTIME_ADAPTER');
  return { profile: required('--profile'), ...(flags.get('--reviewer-profile') ? { reviewerProfile: flags.get('--reviewer-profile')! } : {}), expectedPlatform: required('--expected-platform') as NodeJS.Platform,
    corpus: required('--corpus'), repetitions: Number(required('--repetitions')) as 3, withPhotoshop,
    ...(flags.get('--runtime-adapter') ? { runtimeAdapter: 'qualified-runtime-bridge' as const } : {}), report: required('--report') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = cliOptions(process.argv.slice(2));
    const report = await qualifyModel(options);
    console.log(JSON.stringify({ status: report.status, reasons: report.reasons, report: options.report }));
    if (report.status !== 'trial-passed') process.exitCode = 1;
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; }
}
