import { readFile, lstat, realpath, mkdir, mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalize, sha256Bytes, type FitMode, type OutputSpec } from '@ne-psd/contracts';
import { proposeConfiguration } from '../planner/propose.js';
import { PLANNER_RESPONSE_SCHEMA } from '../planner/request-schema.js';
import { diagnose } from '../diagnostic/diagnose.js';
import type { DiagnosticRequest } from '../diagnostic/schema.js';
import { RuntimeIntelligenceService } from '../review/review.js';
import type { ImageQualityPolicy, ColorExportProof } from '../review/image-quality.js';
import type { TrustedAttemptState } from '../review/evidence-validator.js';
import type { CandidateTrialAdmission } from '../profiles/candidate-trial.js';
import { ModelProfileRegistry } from '../profiles/profile-registry.js';
import { admitCandidateTrial } from '../profiles/candidate-trial.js';
import { verifyModel } from '../cli/verify-model.js';
import { assertModelCapabilityPreflight } from '../profiles/invocation-policy.js';
import type { QualifiedTokenCounter } from '../budget/qualified-token-count.js';
import { loadPrompt } from '../prompts/prompt-registry.js';
import { parseStrictJsonValue } from '../validation/strict-json.js';
import { validateCorpus, type CorpusCase, type CaseOutcome, type RunCorpusOptions } from './run-corpus.js';
import { TransportError, type ModelTransport, type TransportRequest, type TransportResponse } from '../transport/model-transport.js';

export type CorpusDescriptor = Readonly<{
  schemaVersion: 1;
  foundationContractVersion: 1;
  id: string;
  role: 'planner' | 'reviewer' | 'diagnostic';
  mode: 'adapter' | 'response-fault' | 'visual';
  input: Record<string, unknown>;
  visualBundle: unknown;
  responseFault: null | Readonly<{ stage: 'after-live-model-response'; mutation: string; field: string; value: unknown }>;
  preflightFault: null | Readonly<{ kind: string; detail: string; parameters?: Record<string, unknown> }>;
}>;
export type MaterializedCorpusFixture = Readonly<{
  descriptor: CorpusDescriptor;
  bundleRoot: string | null;
  sourceDigests: Readonly<Record<string, string>>;
  cleanup(): Promise<void>;
}>;
export type CorpusFixtureLimits = Readonly<{ maxDescriptorBytes: number; maxFiles: number; maxFileBytes: number; maxTotalBytes: number }>;
export const DEFAULT_CORPUS_LIMITS: CorpusFixtureLimits = Object.freeze({
  maxDescriptorBytes: 2 * 1024 * 1024, maxFiles: 64, maxFileBytes: 8 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024,
});
const LOCKED_MANIFEST_SHA256 = 'b642aa2c45ca287679efbd4d3bd09cd13c2221f3d1c94d1fc5cfc8299415ed47';
const CORPUS_PATH = 'tests/intelligence/fixtures/acceptance-corpus.json';
const LOCK_PATH = 'docs/intelligence/qualification/visual-corpus-manifest.json';

const fail = (code: string): never => { throw new Error(`CORPUS_FIXTURE_${code}`); };
function safeRelative(path: string): boolean {
  return path.length > 0 && path === path.normalize('NFC') && !isAbsolute(path) && !win32.isAbsolute(path) &&
    !/^[A-Za-z]:/.test(path) && !path.includes('\\') && !path.includes('\0') &&
    path.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..' && !/[<>:"|?*\x00-\x1f]/u.test(part));
}
async function readContained(root: string, path: string, limit: number): Promise<Uint8Array> {
  if (!safeRelative(path)) fail('PATH_UNSAFE');
  const target = resolve(root, path);
  const relation = relative(root, target);
  if (!relation || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) fail('PATH_ESCAPE');
  let current = target;
  while (current !== root) {
    const info = await lstat(current).catch(() => fail('PATH_MISSING'));
    if (info.isSymbolicLink()) fail('SYMLINK');
    current = dirname(current);
  }
  if ((await realpath(target)) !== target) fail('PATH_REDIRECT');
  const info = await stat(target);
  if (!info.isFile() || info.size > limit) fail('FILE_BOUND');
  const bytes = await readFile(target);
  if (bytes.byteLength !== info.size || bytes.byteLength > limit) fail('FILE_CHANGED');
  return bytes;
}

export type VerifiedCorpusLock = Readonly<{
  corpusSha256: string;
  fixtureManifestSha256: string;
  descriptorSha256ById: ReadonlyMap<string, string>;
}>;
/** The manifest hash is pinned in code; caller-supplied hashes are never authority. */
export async function verifyCorpusLock(repositoryRoot: string, rows: readonly CorpusCase[]): Promise<VerifiedCorpusLock> {
  validateCorpus(rows);
  const root = await realpath(repositoryRoot);
  const manifestBytes = await readContained(root, LOCK_PATH, 2 * 1024 * 1024);
  if (sha256Bytes(manifestBytes) !== LOCKED_MANIFEST_SHA256) fail('LOCK_MANIFEST_CHANGED');
  const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)) as {
    corpusSha256: string; descriptors: { id: string; path: string; sha256: string }[];
    assets: { path: string; sha256: string; bytes: number }[];
  };
  const corpusBytes = await readContained(root, CORPUS_PATH, 2 * 1024 * 1024);
  if (sha256Bytes(corpusBytes) !== manifest.corpusSha256) fail('LOCK_CORPUS_CHANGED');
  const lockedRows = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(corpusBytes)) as CorpusCase[];
  validateCorpus(lockedRows);
  if (canonicalize(rows) !== canonicalize(lockedRows)) fail('LOCK_EXPECTATIONS_CHANGED');
  if (!Array.isArray(manifest.descriptors) || manifest.descriptors.length !== 64 || !Array.isArray(manifest.assets)) fail('LOCK_INDEX_INVALID');
  const descriptors = new Map<string, string>();
  for (const entry of manifest.descriptors) {
    if (!entry || typeof entry.id !== 'string' || descriptors.has(entry.id) ||
      entry.path !== `tests/intelligence/fixtures/acceptance/cases/${entry.id}/descriptor.json`) fail('LOCK_INDEX_INVALID');
    const bytes = await readContained(root, entry.path, DEFAULT_CORPUS_LIMITS.maxDescriptorBytes);
    if (sha256Bytes(bytes) !== entry.sha256) fail('LOCK_DESCRIPTOR_CHANGED');
    descriptors.set(entry.id, entry.sha256);
    const descriptor = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as CorpusDescriptor;
    if (descriptor.id !== entry.id || descriptor.role !== lockedRows.find((row) => row.id === entry.id)?.role) fail('LOCK_DESCRIPTOR_BINDING');
    const bundle = descriptor.input.bundleRoot;
    const files = (descriptor.input.manifest as { files?: { relativePath: string; sha256: string; bytes: number }[] } | undefined)?.files;
    if (bundle !== undefined) {
      if (bundle !== `tests/intelligence/fixtures/acceptance/cases/${entry.id}/files` || !Array.isArray(files)) return fail('LOCK_BUNDLE_INVALID');
      for (const file of files) {
        if (!safeRelative(file.relativePath)) fail('LOCK_BUNDLE_INVALID');
        let content: Uint8Array;
        try { content = await readContained(root, `${bundle}/${file.relativePath}`, DEFAULT_CORPUS_LIMITS.maxFileBytes); }
        catch (error) {
          if (descriptor.preflightFault?.kind === 'missing-image' && codeOf(error) === 'CORPUS_FIXTURE_PATH_MISSING') continue;
          throw error;
        }
        if (sha256Bytes(content) !== file.sha256 || content.byteLength !== file.bytes) fail('LOCK_BUNDLE_CHANGED');
      }
    }
  }
  if (descriptors.size !== lockedRows.length || lockedRows.some((row) => !descriptors.has(row.id))) fail('LOCK_INDEX_INVALID');
  for (const asset of manifest.assets) {
    if (!safeRelative(asset.path)) fail('LOCK_ASSET_PATH');
    const bytes = await readContained(root, asset.path, DEFAULT_CORPUS_LIMITS.maxFileBytes);
    if (sha256Bytes(bytes) !== asset.sha256 || bytes.byteLength !== asset.bytes) fail('LOCK_ASSET_CHANGED');
  }
  return { corpusSha256: manifest.corpusSha256, fixtureManifestSha256: LOCKED_MANIFEST_SHA256, descriptorSha256ById: descriptors };
}

/** Creates only a private temporary copy. Manifest and source fixture bytes are never edited. */
export async function materializeCorpusFixture(row: Pick<CorpusCase, 'id' | 'role' | 'fixture'>,
  repositoryRoot: string, limits: CorpusFixtureLimits = DEFAULT_CORPUS_LIMITS,
  lockedDescriptorSha256?: string): Promise<MaterializedCorpusFixture> {
  const root = await realpath(repositoryRoot);
  if (!row.fixture.startsWith(`tests/intelligence/fixtures/acceptance/cases/${row.id}/`) ||
    !row.fixture.endsWith('/descriptor.json')) fail('DESCRIPTOR_PATH');
  const raw = await readContained(root, row.fixture, limits.maxDescriptorBytes);
  if (lockedDescriptorSha256 && sha256Bytes(raw) !== lockedDescriptorSha256) fail('LOCK_DESCRIPTOR_CHANGED');
  let descriptor: CorpusDescriptor;
  try { descriptor = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as CorpusDescriptor; }
  catch { fail('DESCRIPTOR_JSON'); }
  if (descriptor!.schemaVersion !== 1 || descriptor!.foundationContractVersion !== 1 || descriptor!.id !== row.id ||
    descriptor!.role !== row.role || !['adapter', 'response-fault', 'visual'].includes(descriptor!.mode) ||
    !descriptor!.input || typeof descriptor!.input !== 'object') fail('DESCRIPTOR_BINDING');
  const bundlePath = descriptor!.input.bundleRoot;
  if (bundlePath === undefined) return { descriptor: descriptor!, bundleRoot: null, sourceDigests: {}, cleanup: async () => undefined };
  if (typeof bundlePath !== 'string' || bundlePath !== `tests/intelligence/fixtures/acceptance/cases/${row.id}/files` || !safeRelative(bundlePath)) fail('BUNDLE_PATH');
  const manifest = descriptor!.input.manifest as { files?: readonly { relativePath: string; sha256: string; bytes: number }[] } | undefined;
  const files = manifest?.files;
  if (!Array.isArray(files) || files.length > limits.maxFiles) fail('MANIFEST_FILES');
  const temp = await realpath(await mkdtemp(join(tmpdir(), `ne-psd-corpus-${row.id}-`)));
  const sourceDigests: Record<string, string> = {};
  let total = 0;
  try {
    const seen = new Set<string>();
    for (const file of files!) {
      if (!file || typeof file.relativePath !== 'string' || !safeRelative(file.relativePath) || seen.has(file.relativePath)) fail('FILE_PATH');
      seen.add(file.relativePath);
      const sourcePath = `${bundlePath}/${file.relativePath}`;
      let bytes: Uint8Array;
      try { bytes = await readContained(root, sourcePath, limits.maxFileBytes); }
      catch (error) {
        if (descriptor!.preflightFault?.kind === 'missing-image' && (error as Error).message === 'CORPUS_FIXTURE_PATH_MISSING') continue;
        throw error;
      }
      total += bytes.byteLength;
      if (total > limits.maxTotalBytes) fail('TOTAL_BOUND');
      if (sha256Bytes(bytes) !== file.sha256 || bytes.byteLength !== file.bytes) fail('SEALED_FILE_MISMATCH');
      const destination = resolve(temp, file.relativePath);
      await mkdir(dirname(destination), { recursive: true });
      await (writeFile as unknown as (path: string, data: Uint8Array) => Promise<void>)(destination, bytes);
      sourceDigests[file.relativePath] = sha256Bytes(bytes);
    }
    const staged: CorpusDescriptor = { ...descriptor!, input: { ...descriptor!.input, bundleRoot: temp } };
    return { descriptor: staged, bundleRoot: temp, sourceDigests, cleanup: () => rm(temp, { recursive: true, force: true }) };
  } catch (error) { await rm(temp, { recursive: true, force: true }); throw error; }
}

function mutateJson(raw: Uint8Array, mutation: string, field: string, replacement: unknown): Uint8Array {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  if (mutation === 'duplicate-keys') return Buffer.from('{"status":"blocked","status":"pass"}');
  if (mutation === 'second-object') return Buffer.from(`${text}\n{}`);
  if (mutation === 'truncated') return Buffer.from(text.slice(0, Math.max(1, Math.floor(text.length / 2))));
  const value = JSON.parse(text) as Record<string, unknown>;
  if (mutation === 'missing-variant-check') {
    const checks = value.variantChecks as unknown[] | undefined;
    if (!checks || checks.length < 3) return fail('FAULT_INPUT_MISSING');
    checks.pop();
  } else if (['fabricated-selector', 'duplicate-variant', 'fit-substitution', 'output-dimensions', 'fabricated-reference', 'unknown-field'].includes(mutation)) {
    if (!field.startsWith('/') || field.includes('//')) fail('FAULT_FIELD');
    const parts = field.slice(1).split('/');
    let target: any = value;
    for (const part of parts.slice(0, -1)) {
      target = target?.[part];
      if (!target || typeof target !== 'object') fail('FAULT_INPUT_MISSING');
    }
    const last = parts.at(-1)!;
    if (mutation !== 'unknown-field' && !(last in target)) fail('FAULT_INPUT_MISSING');
    target[last] = replacement;
  } else fail('FAULT_UNKNOWN');
  return Buffer.from(JSON.stringify(value));
}
/** Faults apply only after a real transport reply; the same host parser then evaluates the bytes. */
export function wrapCorpusTransport(transport: ModelTransport, descriptor: CorpusDescriptor,
  recordModelCall: () => void, observeResponse?: (response: TransportResponse) => void): ModelTransport {
  return { async invoke(request: TransportRequest): Promise<TransportResponse> {
    recordModelCall();
    if (descriptor.preflightFault?.kind === 'endpoint-unavailable') throw new TransportError('MODEL_ENDPOINT_UNAVAILABLE', 'fixture endpoint unavailable');
    const response = await transport.invoke(request);
    if (descriptor.preflightFault?.kind === 'abort-late') throw new TransportError('MODEL_REQUEST_ABORTED', 'late response discarded');
    const fault = descriptor.responseFault;
    if (!fault) { observeResponse?.(response); return response; }
    if (fault.stage !== 'after-live-model-response') fail('FAULT_STAGE');
    if (fault.mutation === 'fallback-model') { const changed = { ...response, modelId: 'substitute-model' }; observeResponse?.(changed); return changed; }
    if (fault.field === 'transport.finishReason') { const changed = { ...response, finishReason: 'length' as const }; observeResponse?.(changed); return changed; }
    if (fault.field !== 'raw' && fault.field !== 'variantChecks' && !/^\/(?:targets\/0\/targetCandidateId|variants\/1\/id|fitMode|output\/width|facts\/0\/evidenceRefs\/0|untrustedAuthority|variantChecks\/2)$/.test(fault.field)) fail('FAULT_FIELD');
    const changed = { ...response, raw: mutateJson(response.raw, fault.mutation, fault.field, fault.value) }; observeResponse?.(changed); return changed;
  } };
}

export type CorpusTrialHost = Readonly<{
  registry: ModelProfileRegistry;
  admission: CandidateTrialAdmission;
  counter: QualifiedTokenCounter;
  manifestPath: string;
}>;
export type CorpusDriverOptions = Readonly<{
  repositoryRoot: string;
  planner: CorpusTrialHost;
  reviewer: CorpusTrialHost;
  transport: ModelTransport;
  deadlineMs?: number;
  limits?: CorpusFixtureLimits;
}>;
type Input = Record<string, any>;
const codeOf = (error: unknown): string => error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
  ? error.code : error instanceof Error ? error.message : String(error);
const rawValue = (response: TransportResponse | null): unknown => {
  if (!response) return null;
  try { return parseStrictJsonValue(response.raw); } catch { return null; }
};
const evidenceRefs = (value: unknown, input: Input): string[] => {
  const refs = new Set<string>();
  if (input.inspection?.evidencePaths) for (const ref of input.inspection.evidencePaths) refs.add(ref);
  if (input.diagnosticRequest?.evidenceRefs) for (const ref of input.diagnosticRequest.evidenceRefs) refs.add(ref);
  if (input.manifest?.files) for (const file of input.manifest.files) refs.add(file.relativePath);
  if (value && typeof value === 'object') {
    const v = value as Input;
    for (const item of [...v.facts ?? [], ...v.variantChecks ?? [], ...v.checks ?? [], ...v.findings ?? []])
      for (const ref of item.evidenceRefs ?? []) refs.add(ref);
    for (const ref of v.evidenceRefs ?? []) refs.add(ref);
  }
  return [...refs];
};
const hostFailure = (role: CorpusDescriptor['role'], error: unknown, response: TransportResponse | null): string => {
  const code = codeOf(error);
  if (code.includes('CONTEXT_BUDGET_EXCEEDED')) return 'CONTEXT_BUDGET_EXCEEDED';
  if (code.includes('MODEL_REQUEST_ABORTED')) return 'MODEL_REQUEST_ABORTED';
  if (code.includes('MODEL_ENDPOINT_UNAVAILABLE')) return 'MODEL_ENDPOINT_UNAVAILABLE';
  if (code.includes('MODEL_IDENTITY_MISMATCH')) return 'MODEL_IDENTITY_MISMATCH';
  if (code.includes('MODEL_RESPONSE_INCOMPLETE')) return 'MODEL_RESPONSE_INCOMPLETE';
  if (code.includes('VISION_REQUIRED') || code.includes('VISION_PROFILE_UNQUALIFIED')) return 'VISION_PROFILE_UNQUALIFIED';
  if (code.includes('JSON_SCHEMA_REQUIRED') || code.includes('MODEL_CAPABILITY_UNQUALIFIED')) return 'MODEL_CAPABILITY_UNQUALIFIED';
  if (code.includes('MODEL_NOT_QUALIFIED') || code.includes('MODEL_PROFILE_NOT_QUALIFIED') || code.includes('TOKEN_COUNTER_UNQUALIFIED')) return 'MODEL_PROFILE_NOT_QUALIFIED';
  if (role === 'reviewer') {
    if (response && code.includes('REVIEW_FALSE_PASS')) return 'VISUAL_DEFECT';
    return response ? 'REVIEW_DECISION_INVALID' : 'EVIDENCE_INVALID';
  }
  if (role === 'diagnostic') return 'DIAGNOSTIC_INVALID';
  if (code.startsWith('MODEL_RESPONSE_') || code.includes('STRICT_JSON') || code === 'PROPOSAL_EVIDENCE_REFERENCE_UNKNOWN') return 'STRICT_JSON_INVALID';
  return response ? 'PROPOSAL_INVALID' : code;
};

/** Measure the same planner packet the host will send; descriptor example counts never enter a verdict. */
async function prepareBudget(descriptor: CorpusDescriptor, host: CorpusTrialHost, signal: AbortSignal): Promise<{ instruction: string; safetyTokens: number }> {
  const input = descriptor.input as Input;
  const kind = descriptor.preflightFault?.kind;
  if (!['exact-context', 'over-input', 'over-output'].includes(kind ?? '')) return { instruction: String(input.instruction), safetyTokens: 1024 };
  const recipe = descriptor.preflightFault?.parameters?.budgetRecipe as Input | undefined;
  if (!recipe || recipe.source !== 'qualified-counter.countPacket' || recipe.packetFrom !== 'real-planner-adapter' || recipe.variableField !== '/instruction') return fail('BUDGET_RECIPE');
  const prompt = await loadPrompt('planner');
  const profile = host.admission.profile;
  const filler = typeof recipe.filler === 'string' && recipe.filler ? recipe.filler : ' corpus measured padding';
  const limit = Math.min(Number(recipe.maxSearchSteps) || 0, 10000);
  if (limit < 1) fail('BUDGET_RECIPE');
  const context = Math.min(profile.contextTokens, host.counter.runtimeContextTokens);
  const safetyTokens = 1024;
  let instruction = String(input.instruction);
  for (let step = 0; step < limit; step++) {
    const user = { kind: 'configuration-proposal', schemaVersion: 1, instruction, inspection: input.inspection,
      requestedFitMode: input.requestedFitMode ?? null, requestedOutput: input.requestedOutput ?? null,
      instructionEvidence: input.instructionEvidence ?? [] };
    const packet: TransportRequest = { profile, sessionId: 'corpus-budget-measurement',
      messages: [{ role: 'system', content: prompt.text }, { role: 'user', content: canonicalize(user) }],
      responseSchema: PLANNER_RESPONSE_SCHEMA, sampling: { temperature: 0, stream: false }, maxOutputBytes: 256 * 1024,
      maxOutputTokens: profile.maxOutputTokens, deadlineMs: 300000, signal };
    const counts = host.counter.countPacket(packet);
    const inputTokens = counts.systemTokens + counts.userTokens + counts.schemaTokens + counts.wrapperTokens + counts.imageTokens;
    const total = inputTokens + packet.maxOutputTokens + safetyTokens;
    if (kind === 'exact-context' && total === context) return { instruction, safetyTokens };
    if (kind === 'over-input' && inputTokens > context) return { instruction, safetyTokens };
    if (kind === 'over-output' && inputTokens + safetyTokens <= context && total > context) return { instruction, safetyTokens };
    if (total > context && kind === 'exact-context') break;
    instruction += filler;
  }
  return fail('BUDGET_RECIPE_UNREACHABLE');
}

async function invokeHost(descriptor: CorpusDescriptor, host: CorpusTrialHost, transport: ModelTransport,
  signal: AbortSignal, deadlineMs: number, instruction: string, safetyTokens: number): Promise<unknown> {
  const input = descriptor.input as Input;
  const profileId = host.admission.profile.profileId;
  const capabilityFault = descriptor.preflightFault?.kind === 'unsupported-schema' || descriptor.preflightFault?.kind === 'false-vision';
  const faultyRegistry = capabilityFault ? new ModelProfileRegistry() : null;
  if (faultyRegistry) faultyRegistry.register({ ...host.admission.profile,
    capabilities: { ...host.admission.profile.capabilities,
      ...(descriptor.preflightFault?.parameters?.profileCapabilities as object) } });
  const registry = faultyRegistry ?? host.registry;
  const trialAdmission = descriptor.preflightFault?.kind === 'unverified-artifact' || capabilityFault ? undefined : host.admission;
  if (descriptor.role === 'planner') return proposeConfiguration({ inspection: input.inspection, instruction,
    instructionEvidence: input.instructionEvidence ?? [], requestedFitMode: input.requestedFitMode as FitMode,
    requestedOutput: input.requestedOutput as OutputSpec | undefined,
    modelProfileId: profileId, registry, transport, sessionId: `corpus-${descriptor.id}`,
    signal, deadlineMs, tokenCounter: host.counter, safetyTokens, trialAdmission });
  if (descriptor.role === 'diagnostic') return diagnose(input.diagnosticRequest as DiagnosticRequest, transport, profileId,
    registry, { signal, deadlineMs, tokenCounter: host.counter, safetyTokens, correctionCode: input.correctionCode,
      visualAttestation: true, trialAdmission });
  if (!input.bundleRoot) fail('REVIEW_BUNDLE_MISSING');
  const job = { ...input.job, reviewerModelProfileId: profileId };
  const trustedState = { ...input.trustedState, job } as TrustedAttemptState;
  const service = new RuntimeIntelligenceService({ registry, transport,
    counterFor: (id: string) => id === profileId ? host.counter : null,
    readAttempt: async () => trustedState,
    readLimits: { maxFiles: DEFAULT_CORPUS_LIMITS.maxFiles, maxFileBytes: DEFAULT_CORPUS_LIMITS.maxFileBytes,
      maxTotalBytes: DEFAULT_CORPUS_LIMITS.maxTotalBytes },
    resolveAttemptRoot: async () => input.bundleRoot,
    imageQualityPolicy: async () => input.imageQualityPolicy as ImageQualityPolicy | null,
    colorTrace: async () => input.colorTraceSelection as { relativePath: string; proofs: readonly ColorExportProof[] } | null,
    safeCleanup: async () => true, admissibleCorrections: async () => [],
    readTrustedAttestation: async () => null,
    deadlineMs, safetyTokens, trialAdmission });
  return service.review({ manifest: input.manifest, evidence: input.evidence, policy: input.policy }, profileId, signal);
}

/** Hooks for runCorpus. Expectations stay in runCorpus; this adapter reports only host observations. */
export function createCorpusDriver(options: CorpusDriverOptions): Pick<RunCorpusOptions, 'corpusLock' | 'preflight' | 'invoke'> {
  const deadlineMs = options.deadlineMs ?? 300000;
  const selected = (row: CorpusCase) => row.role === 'reviewer' ? options.reviewer : options.planner;
  let lock: VerifiedCorpusLock | null = null;
  const lockedDigest = (row: CorpusCase): string => {
    const digest = lock?.descriptorSha256ById.get(row.id);
    if (!digest) fail('LOCK_REQUIRED');
    return digest!;
  };
  return {
    async corpusLock(rows) {
      lock = await verifyCorpusLock(options.repositoryRoot, rows);
      return { corpusSha256: lock.corpusSha256, fixtureManifestSha256: lock.fixtureManifestSha256 };
    },
    async preflight(row, _profileId, signal) {
      const fixture = await materializeCorpusFixture(row, options.repositoryRoot, options.limits, lockedDigest(row));
      try {
        const descriptor = fixture.descriptor;
        const kind = descriptor.preflightFault?.kind;
        if (!kind || ['abort-late', 'endpoint-unavailable', 'exact-context'].includes(kind)) return null;
        if (kind === 'wrong-os') {
          const resources = descriptor.preflightFault?.parameters?.resources as Input | undefined;
          if (!resources || typeof resources.os !== 'string' || typeof resources.expectedOs !== 'string' ||
            resources.os === resources.expectedOs) return fail('WRONG_OS_SETUP');
          const original = await verifyModel({ manifest: selected(row).manifestPath,
            expectedPlatform: process.platform, artifactOnly: true });
          if (!original.ok) return fail('WRONG_OS_SOURCE_UNVERIFIED');
          const wrongPlatform = resources.os === process.platform ? resources.expectedOs : resources.os;
          const mismatch = await verifyModel({ manifest: selected(row).manifestPath,
            expectedPlatform: wrongPlatform, artifactOnly: true });
          if (mismatch.ok || !('code' in mismatch) || mismatch.code !== 'PLATFORM_MISMATCH') return fail('WRONG_OS_SETUP');
          let rejected = false;
          try { await admitCandidateTrial({ manifestPath: selected(row).manifestPath,
            expectedPlatform: wrongPlatform as NodeJS.Platform, probe: selected(row).admission.probe,
            counter: selected(row).counter, role: selected(row).admission.role }); }
          catch { rejected = true; }
          if (!rejected) return fail('WRONG_OS_NOT_REJECTED');
          return 'RUNTIME_QUALIFICATION_MISMATCH';
        }
        const host = selected(row);
        const budget = await prepareBudget(descriptor, host, signal);
        if (kind === 'unsupported-schema' || kind === 'false-vision') {
          const capabilities = descriptor.preflightFault?.parameters?.profileCapabilities as Input | undefined;
          if (!capabilities) fail('CAPABILITY_FAULT_MISSING');
          try { assertModelCapabilityPreflight({ ...host.admission.profile, capabilities: {
            ...host.admission.profile.capabilities, ...capabilities } }, row.role === 'reviewer' ? 'reviewer' : 'planner'); }
          catch (error) {
            const code = hostFailure(row.role, error, null);
            return kind === 'false-vision' && code === 'MODEL_CAPABILITY_UNQUALIFIED' ? 'VISION_PROFILE_UNQUALIFIED' : code;
          }
          fail('CAPABILITY_FAULT_NOT_REJECTED');
        }
        let attempted = false;
        const stop: ModelTransport = { invoke: async () => { attempted = true; throw new Error('CORPUS_PREFLIGHT_REACHED_TRANSPORT'); } };
        try { await invokeHost(descriptor, host, stop, signal, deadlineMs, budget.instruction, budget.safetyTokens); }
        catch (error) {
          if (attempted) return null;
          if (codeOf(error).startsWith('CORPUS_FIXTURE_')) throw error;
          const code = hostFailure(row.role, error, null);
          if (kind === 'unsupported-schema' && code === 'MODEL_CAPABILITY_UNQUALIFIED') return code;
          if (kind === 'unverified-artifact' && code === 'MODEL_PROFILE_NOT_QUALIFIED') return code;
          if (kind === 'false-vision' && (code === 'MODEL_PROFILE_NOT_QUALIFIED' || code === 'VISION_PROFILE_UNQUALIFIED')) return 'VISION_PROFILE_UNQUALIFIED';
          return code;
        }
        return null;
      } finally { await fixture.cleanup(); }
    },
    async invoke(row, _profileId, signal, recordModelCall) {
      const fixture = await materializeCorpusFixture(row, options.repositoryRoot, options.limits, lockedDigest(row));
      let calls = 0;
      let response: TransportResponse | null = null;
      try {
        const descriptor = fixture.descriptor;
        const host = selected(row);
        const budget = await prepareBudget(descriptor, host, signal);
        const transport = wrapCorpusTransport(options.transport, descriptor, () => { calls++; recordModelCall(); }, (value) => { response = value; });
        let value: unknown = null, failureCode: string | null = null;
        try { value = await invokeHost(descriptor, host, transport, signal, deadlineMs, budget.instruction, budget.safetyTokens); }
        catch (error) {
          if (codeOf(error).startsWith('CORPUS_FIXTURE_')) throw error;
          failureCode = hostFailure(row.role, error, response);
          if (descriptor.responseFault?.mutation === 'duplicate-variant' && codeOf(error) === 'MODEL_RESPONSE_SCHEMA_INVALID')
            failureCode = 'PROPOSAL_INVALID';
          value = null;
        }
        const seeded = descriptor.visualBundle && typeof descriptor.visualBundle === 'object'
          ? (descriptor.visualBundle as Input).seededDefect as Input | null : null;
        const candidateDecision = value && typeof value === 'object' ? value as Input : null;
        const hasVisualDefect = descriptor.role === 'reviewer' && seeded && candidateDecision?.findings?.some(
          (finding: Input) => finding.code === seeded.code && finding.severity === seeded.severity &&
            finding.evidenceRefs?.length > 0);
        if (!failureCode && hasVisualDefect && candidateDecision?.verdict !== 'pass') failureCode = 'VISUAL_DEFECT';
        const admitted = failureCode === null;
        const candidate = (value && typeof value === 'object' ? value : {}) as Input;
        const raw = rawValue(response) as Input | null;
        const found = raw?.findings?.some((finding: Input) => finding.code === seeded?.code && finding.severity === seeded?.severity);
        return { admitted, status: admitted ? (candidate.status ?? candidate.verdict ?? null) : null, value,
          failureCode, profileId: host.admission.profile.profileId, modelCalls: calls,
          outputTokens: (response as TransportResponse | null)?.usage?.outputTokens ?? null,
          evidenceRefs: evidenceRefs(value, descriptor.input as Input), observedDefects: found ? [descriptor.id] : [],
          validation: { schemaValid: admitted, bindingValid: admitted, checkSetComplete: admitted,
            prohibitedAction: false } } satisfies CaseOutcome;
      } finally { await fixture.cleanup(); }
    },
  };
}
