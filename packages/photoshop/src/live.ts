import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, copyFile, lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import sharp from 'sharp';
import {
  ConfigurationProposalSchema, InspectionReportSchema, QualificationResultSchema,
  RenderEvidenceSchema, TemplateProfileSchema,
  type ConfigurationProposal, type InspectionReport, type QualificationRequest,
  type QualificationResult, type RenderEvidence, type TemplateCandidate, type TemplateProfile,
} from '@ne-psd/contracts';
import { buildPinnedLaunchParameters } from './mcp-client.js';

const exec = promisify(execFile);
const SHA256 = /^[a-f0-9]{64}$/;
const MODES = ['cover', 'contain', 'stretch'] as const;
const FORMATS = ['jpeg', 'png'] as const;
const FIELDS = [
  'schemaVersion', 'platform', 'backendId', 'installationPath', 'installationExecutable',
  'nodeExecutable', 'serverEntry', 'sourceRoot', 'sourcePath', 'assetRoot', 'assetPath',
  'workRoot', 'evidenceRoot', 'lockPath',
] as const;

export type LiveMachine = {
  schemaVersion: 1;
  platform: 'darwin' | 'win32';
  backendId: 'alisaitteke' | 'dcc-mcp-photoshop';
  installationPath: string;
  installationExecutable: string;
  nodeExecutable: string;
  serverEntry: string;
  sourceRoot: string;
  sourcePath: string;
  assetRoot: string;
  assetPath: string;
  workRoot: string;
  evidenceRoot: string;
  lockPath: string;
};
export type LiveBlock = { code: string; message: string };
export type LiveProbe = { config: LiveMachine | null; blocked: LiveBlock[] };
export type LiveDependency = { path: string; sha256: string; bytes: number };
export type PreparedLiveTemplate = { workingTemplatePath: string; dependencies: LiveDependency[] };
export type LiveCase = { mode: typeof MODES[number]; format: typeof FORMATS[number]; profile: TemplateProfile; ownedAssetPath: string; stagingDirectory: string };
export type LiveComposition = {
  inspect(templatePath: string, signal: AbortSignal): Promise<InspectionReport>;
  prepareTemplate(templatePath: string, attemptRoot: string, inspection: InspectionReport, signal: AbortSignal): Promise<PreparedLiveTemplate>;
  propose(inspection: InspectionReport, signal: AbortSignal): Promise<ConfigurationProposal>;
  qualify(request: QualificationRequest, signal: AbortSignal): Promise<QualificationResult>;
  seal(candidate: TemplateCandidate, mode: LiveCase['mode'], format: LiveCase['format'], signal: AbortSignal): Promise<TemplateProfile>;
  renderCase(input: LiveCase, signal: AbortSignal): Promise<RenderEvidence>;
  cleanup(signal: AbortSignal): Promise<{ quiescent: true; ownedDocuments: []; foreignDocumentsPreserved: true }>;
};
export type LiveResult =
  | { status: 'blocked'; blocks: LiveBlock[] }
  | { status: 'protocol-exercised'; evidencePath: string; blocks: [] };

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const absolute = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) throw new Error('B15_LIVE_CONFIG_INVALID:' + name);
  return value;
};
const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
};

export function parseLiveMachine(value: unknown): LiveMachine {
  if (!record(value) || value.schemaVersion !== 1 || Object.keys(value).some((key) => !(FIELDS as readonly string[]).includes(key))) throw new Error('B15_LIVE_CONFIG_INVALID:fields');
  if (value.platform !== 'darwin' && value.platform !== 'win32') throw new Error('B15_LIVE_CONFIG_INVALID:platform');
  if (value.backendId !== 'alisaitteke' && value.backendId !== 'dcc-mcp-photoshop') throw new Error('B15_LIVE_CONFIG_INVALID:backendId');
  return {
    schemaVersion: 1, platform: value.platform, backendId: value.backendId,
    installationPath: absolute(value.installationPath, 'installationPath'),
    installationExecutable: absolute(value.installationExecutable, 'installationExecutable'),
    nodeExecutable: absolute(value.nodeExecutable, 'nodeExecutable'),
    serverEntry: absolute(value.serverEntry, 'serverEntry'),
    sourceRoot: absolute(value.sourceRoot, 'sourceRoot'),
    sourcePath: absolute(value.sourcePath, 'sourcePath'),
    assetRoot: absolute(value.assetRoot, 'assetRoot'),
    assetPath: absolute(value.assetPath, 'assetPath'),
    workRoot: absolute(value.workRoot, 'workRoot'),
    evidenceRoot: absolute(value.evidenceRoot, 'evidenceRoot'),
    lockPath: absolute(value.lockPath, 'lockPath'),
  };
}

async function noSymlinkComponents(path: string): Promise<void> {
  const parts: string[] = [];
  let current = resolve(path);
  while (dirname(current) !== current) { parts.unshift(current); current = dirname(current); }
  for (const part of parts) {
    const info = await lstat(part);
    if (info.isSymbolicLink()) throw new Error('B15_PATH_SYMLINK:' + part);
  }
}
async function canonical(path: string, type: 'file' | 'directory', executable = false): Promise<string> {
  await noSymlinkComponents(path);
  const info = await stat(path);
  if (type === 'file' ? !info.isFile() : !info.isDirectory()) throw new Error('B15_PATH_TYPE:' + path);
  if (executable) await access(path, constants.X_OK);
  return realpath(path);
}
async function digest(path: string): Promise<{ sha256: string; bytes: number }> {
  const bytes = await readFile(path);
  return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.byteLength };
}
async function unchanged(path: string, initial: { sha256: string; bytes: number }): Promise<void> {
  const after = await digest(path);
  if (after.sha256 !== initial.sha256 || after.bytes !== initial.bytes) throw new Error('B15_ORIGINAL_MUTATED:' + path);
}

export async function probeLiveMachine(config: LiveMachine): Promise<LiveBlock[]> {
  const blocks: LiveBlock[] = [];
  if (config.platform !== process.platform) blocks.push({ code: 'B15_PLATFORM_MISMATCH', message: process.platform + ' differs from ' + config.platform });
  const resolved: Record<string, string> = {};
  for (const [name, type, executable] of [
    ['installationPath', 'directory', false], ['installationExecutable', 'file', true],
    ['nodeExecutable', 'file', true], ['serverEntry', 'file', false],
    ['sourceRoot', 'directory', false], ['sourcePath', 'file', false],
    ['assetRoot', 'directory', false], ['assetPath', 'file', false],
    ['workRoot', 'directory', false], ['evidenceRoot', 'directory', false],
  ] as const) {
    try { resolved[name] = await canonical(config[name], type, executable); }
    catch (error) { blocks.push({ code: 'B15_PATH_INVALID', message: name + ': ' + String(error) }); }
  }
  try {
    const parent = await canonical(dirname(config.lockPath), 'directory');
    if (!resolved.workRoot || !inside(resolved.workRoot, parent)) throw new Error('lock parent must be inside workRoot');
    try { const info = await lstat(config.lockPath); if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('lock leaf is not a real directory'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  } catch (error) { blocks.push({ code: 'B15_LOCK_PATH_INVALID', message: String(error) }); }
  if (resolved.installationPath && resolved.installationExecutable && !inside(resolved.installationPath, resolved.installationExecutable)) blocks.push({ code: 'B15_INSTALLATION_MISMATCH', message: 'executable is outside selected installation' });
  if (resolved.sourceRoot && resolved.sourcePath && !inside(resolved.sourceRoot, resolved.sourcePath)) blocks.push({ code: 'B15_SOURCE_ESCAPE', message: 'template is outside source root' });
  if (resolved.assetRoot && resolved.assetPath && !inside(resolved.assetRoot, resolved.assetPath)) blocks.push({ code: 'B15_ASSET_ESCAPE', message: 'asset is outside asset root' });
  for (const root of ['sourceRoot', 'assetRoot'] as const) for (const output of ['workRoot', 'evidenceRoot'] as const) {
    if (resolved[root] && resolved[output] && (inside(resolved[root], resolved[output]) || inside(resolved[output], resolved[root]) || resolved[root] === resolved[output])) blocks.push({ code: 'B15_ROOT_OVERLAP', message: root + ' overlaps ' + output });
  }
  if (resolved.workRoot && resolved.evidenceRoot && (inside(resolved.workRoot, resolved.evidenceRoot) || inside(resolved.evidenceRoot, resolved.workRoot) || resolved.workRoot === resolved.evidenceRoot)) blocks.push({ code: 'B15_ROOT_OVERLAP', message: 'workRoot overlaps evidenceRoot' });
  try {
    buildPinnedLaunchParameters({ nodeExecutable: config.nodeExecutable, serverEntry: config.serverEntry, explicitArgs: ['--stdio'] });
    const version = (await exec(config.nodeExecutable, ['--version'])).stdout.trim();
    if (version !== 'v22.23.2') throw new Error('expected v22.23.2, got ' + version);
  } catch (error) { blocks.push({ code: 'B15_PINNED_RUNTIME_INVALID', message: String(error) }); }
  if (config.backendId !== 'alisaitteke') blocks.push({ code: 'B15_ALTERNATE_UNQUALIFIED', message: 'alternate backend needs separate source/license/schema qualification' });
  return blocks;
}

export async function readLiveMachine(path: string): Promise<LiveProbe> {
  let value: unknown;
  try { value = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { config: null, blocked: [{ code: 'B15_LIVE_CONFIG_MISSING', message: path }] };
    return { config: null, blocked: [{ code: 'B15_LIVE_CONFIG_INVALID', message: String(error) }] };
  }
  try { const config = parseLiveMachine(value); return { config, blocked: await probeLiveMachine(config) }; }
  catch (error) { return { config: null, blocked: [{ code: 'B15_LIVE_CONFIG_INVALID', message: String(error) }] }; }
}

async function confinedFile(root: string, name: string): Promise<string> {
  const path = resolve(root, name);
  if (!inside(root, path)) throw new Error('B15_OUTPUT_ESCAPE');
  const actual = await canonical(path, 'file');
  if (!inside(root, actual)) throw new Error('B15_OUTPUT_ESCAPE');
  return actual;
}
async function artifactBytes(root: string, evidence: RenderEvidence, profile: TemplateProfile, mode: LiveCase['mode'], format: LiveCase['format']): Promise<void> {
  if (evidence.geometry.length === 0 || evidence.geometry.some((item) => item.fitMode !== mode || !item.clipped || !item.adjacentToReference)) throw new Error('B15_GEOMETRY_UNPROVEN');
  if (evidence.checks.length === 0 || evidence.checks.some((item) => !item.passed)) throw new Error('B15_CHECK_FAILED');
  if (evidence.visibility.length !== 3 || evidence.visibility.map((item) => item.variantId).sort().join(',') !== '1,2,3' || evidence.visibility.some((item) => item.visibleVariantIds.length !== 1 || item.visibleVariantIds[0] !== item.variantId)) throw new Error('B15_VISIBILITY_UNPROVEN');
  if (evidence.artifacts.length !== 3 || evidence.artifacts.map((item) => item.variantId).sort().join(',') !== '1,2,3') throw new Error('B15_VARIANT_SET_INVALID');
  if (new Set(evidence.artifacts.map((item) => item.path.toLowerCase())).size !== 3) throw new Error('B15_OUTPUT_COLLISION');
  await confinedFile(root, evidence.documentTracePath);
  await confinedFile(root, evidence.toolTracePath);
  for (const check of evidence.checks) await confinedFile(root, check.evidencePath);
  for (const artifact of evidence.artifacts) {
    if (artifact.format !== format || artifact.colorSpace !== 'sRGB') throw new Error('B15_EXPORT_POLICY_MISMATCH');
    if (artifact.width !== profile.output.width || artifact.height !== profile.output.height) throw new Error('B15_OUTPUT_DIMENSIONS_MISMATCH');
    const actual = await confinedFile(root, artifact.path);
    const bytes = await digest(actual);
    if (bytes.sha256 !== artifact.sha256 || bytes.bytes !== artifact.bytes) throw new Error('B15_OUTPUT_HASH_MISMATCH');
    const image = await sharp(actual, { failOn: 'error' }).metadata();
    if (image.format !== format || image.width !== artifact.width || image.height !== artifact.height || image.space !== 'srgb' || image.hasProfile !== true || !image.icc || (format === 'jpeg' && image.hasAlpha)) throw new Error('B15_OUTPUT_IMAGE_INVALID');
  }
}

export async function runLiveQualification(config: LiveMachine, composition?: LiveComposition, signal: AbortSignal = new AbortController().signal): Promise<LiveResult> {
  const blocks = await probeLiveMachine(config);
  if (blocks.length) return { status: 'blocked', blocks };
  if (!composition) return { status: 'blocked', blocks: [{ code: 'B15_LIVE_COMPOSITION_UNAVAILABLE', message: 'qualified inspection, proposal, B qualifier, A sealer and v2 owned-input renderer are not wired' }] };
  const originals = new Map<string, { sha256: string; bytes: number }>();
  let started = false;
  try {
    const templatePath = await canonical(config.sourcePath, 'file');
    const assetPath = await canonical(config.assetPath, 'file');
    originals.set(templatePath, await digest(templatePath));
    originals.set(assetPath, await digest(assetPath));
    const workRoot = await canonical(config.workRoot, 'directory');
    const evidenceRoot = await canonical(config.evidenceRoot, 'directory');
    const attemptRoot = join(workRoot, 'b15-' + randomUUID());
    const evidenceDirectory = join(evidenceRoot, basename(attemptRoot));
    await mkdir(attemptRoot);
    await mkdir(evidenceDirectory);
    if (!inside(workRoot, await canonical(attemptRoot, 'directory')) || !inside(evidenceRoot, await canonical(evidenceDirectory, 'directory'))) throw new Error('B15_ATTEMPT_ROOT_ESCAPE');
    const ownedAssetPath = join(attemptRoot, 'asset' + (basename(assetPath).match(/\.[^.]+$/)?.[0] ?? '.bin'));
    await copyFile(assetPath, ownedAssetPath);
    if ((await digest(ownedAssetPath)).sha256 !== originals.get(assetPath)!.sha256) throw new Error('B15_ASSET_COPY_MISMATCH');
    const preDispatch = await probeLiveMachine(config);
    if (preDispatch.length) throw new Error('B15_PRE_DISPATCH_PROBE_FAILED:' + preDispatch.map((item) => item.code).join(','));
    started = true;
    const inspection = InspectionReportSchema.parse(await composition.inspect(templatePath, signal));
    if (inspection.evidenceStatus !== 'liveObserved' || !inspection.capabilities || inspection.capabilities.backendId !== config.backendId) throw new Error('B15_INSPECTION_UNQUALIFIED');
    if (inspection.unresolvedLinks.length || inspection.documents.some((document) => document.sourceKind === 'unknown')) throw new Error('B15_LINKAGE_UNRESOLVED');
    const prepared = await composition.prepareTemplate(templatePath, attemptRoot, inspection, signal);
    const workingTemplatePath = await canonical(prepared.workingTemplatePath, 'file');
    if (!inside(attemptRoot, workingTemplatePath)) throw new Error('B15_WORKING_TEMPLATE_ESCAPE');
    for (const dependency of prepared.dependencies) {
      const path = await canonical(dependency.path, 'file');
      if (!inside(await canonical(config.sourceRoot, 'directory'), path) || !SHA256.test(dependency.sha256)) throw new Error('B15_DEPENDENCY_INVALID');
      const actual = await digest(path);
      if (actual.sha256 !== dependency.sha256 || actual.bytes !== dependency.bytes) throw new Error('B15_DEPENDENCY_HASH_MISMATCH');
      originals.set(path, actual);
    }
    const linkedDigests = new Set(inspection.documents.filter((document) => document.sourceKind === 'linked').map((document) => document.source?.sha256));
    if (linkedDigests.has(undefined) || [...linkedDigests].some((sha256) => !prepared.dependencies.some((dependency) => dependency.sha256 === sha256))) throw new Error('B15_LINKED_CLOSURE_INCOMPLETE');
    const proposal = ConfigurationProposalSchema.parse(await composition.propose(inspection, signal));
    if (proposal.status !== 'proposed') throw new Error('B15_PROPOSAL_BLOCKED');
    const qualification = QualificationResultSchema.parse(await composition.qualify({ schemaVersion: 1, inspection, proposal, workingTemplatePath, evidenceDirectory }, signal));
    if (qualification.status !== 'qualified' || !qualification.candidate || qualification.checks.length === 0 || qualification.checks.some((check) => !check.passed)) throw new Error('B15_QUALIFICATION_BLOCKED');
    const cases: Array<{ mode: LiveCase['mode']; format: LiveCase['format']; profileSha256: string }> = [];
    for (const mode of MODES) for (const format of FORMATS) {
      if (signal.aborted) throw new Error('B15_CANCELLED');
      const profile = TemplateProfileSchema.parse(await composition.seal(qualification.candidate, mode, format, signal));
      if (profile.fitMode !== mode || profile.output.format !== format || profile.backendId !== config.backendId || profile.toolSchemaSha256 !== inspection.capabilities.toolSchemaSha256 || profile.template.sha256 !== qualification.candidate.template.sha256) throw new Error('B15_A_SEAL_MISMATCH');
      const stagingDirectory = join(attemptRoot, mode + '-' + format);
      await mkdir(stagingDirectory);
      const evidence = RenderEvidenceSchema.parse(await composition.renderCase({ mode, format, profile, ownedAssetPath, stagingDirectory }, signal));
      if (evidence.profileSha256 !== profile.profileSha256 || evidence.sourceSha256 !== originals.get(assetPath)!.sha256) throw new Error('B15_RENDER_IDENTITY_MISMATCH');
      await artifactBytes(stagingDirectory, evidence, profile, mode, format);
      cases.push({ mode, format, profileSha256: profile.profileSha256 });
    }
    const cleanup = await composition.cleanup(new AbortController().signal);
    if (!cleanup.quiescent || cleanup.ownedDocuments.length !== 0 || !cleanup.foreignDocumentsPreserved) throw new Error('B15_CLEANUP_UNPROVEN');
    started = false;
    for (const [path, initial] of originals) await unchanged(path, initial);
    const summary = join(evidenceDirectory, 'live-sequence.json');
    await writeFile(summary, JSON.stringify({ schemaVersion: 1, cases, originals: [...originals], cleanup }, null, 2));
    return { status: 'protocol-exercised', evidencePath: summary, blocks: [] };
  } catch (error) {
    if (started) { try { await composition.cleanup(new AbortController().signal); } catch { /* retain uncertainty */ } }
    return { status: 'blocked', blocks: [{ code: 'B15_LIVE_SEQUENCE_FAILED', message: String(error) }] };
  }
}
