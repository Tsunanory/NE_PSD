import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  canonicalize, PrepareRequestV2Schema, RecoveryRequestV2Schema,
  RenderEvidenceSchema, RenderRequestV2Schema,
  validateOwnedInputProofV2, validatePreparedInputManifestV2,
  validateRecoveryResultV2, validateReleaseProofV2, validateRenderEvidenceV2,
  validateRenderRequestV2, validateTemplateClosureProofV2,
  type PhotoshopBackendV2, type PrepareRequestV2, type PreparedInputManifestV2,
  type RecoveryRequestV2, type RecoveryResultV2, type RenderEvidence,
  type RenderEvidenceV2, type RenderRequestV2,
} from '@ne-psd/contracts';
import type { SessionLock } from './session-lock.js';
import { OperationJournal, recoverJob, type RecoveryRuntime } from './recovery.js';
import { createWorkingCopy, type QualifiedLinkOperation } from './working-copy.js';
import { validateCanonicalTrace } from './backend.js';
import { inspectExportFile } from './export.js';
import type { CanonicalTraceRecord } from './types.js';
import {
  ASSET_CLOSURE_PROOF_V2_PATH, PREPARED_INPUT_MANIFEST_V2_PATH,
  prepareOwnedInputV2, sourceRootIdentity,
} from './prepare-v2.js';

const sha = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex');
const inside = (root: string, target: string): boolean => {
  const rel = relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
type Identity = Pick<RecoveryRequestV2, 'jobId' | 'assetId' | 'attempt' | 'operationId'>;
type CopyMeasurement = {
  original: { rootId: string; relativePath: string; sha256: string };
  ownedRelativePath: string;
  bytes: number;
  originalBeforeSha256: string;
  originalAfterSha256: string;
  copyBeforeSha256: string;
  copyAfterSha256: string;
};
type PreparedClosure = {
  schemaVersion: 2; jobId: string; assetId: string; attempt: 1 | 2; operationId: string;
  sourceRootIdentity: string;
  source: { relativePath: string; sha256: string; bytes: number };
  dependencies: Array<{ identity: string; original: CopyMeasurement['original']; bytes: number; sourceKind: 'linked' }>;
  observedLinks: Array<{ parent: string; child: string; identity: string }>;
  closureComplete: true;
};

export class BackendV2Error extends Error {
  readonly category = 'ambiguousState';
  readonly retryable = false;
  constructor(readonly code: string, message: string) { super(`${code}: ${message}`); this.name = 'BackendV2Error'; }
}

async function actualFile(root: string, relativePath: string): Promise<string> {
  if (!relativePath || relativePath.includes('\0') || relativePath.includes('\\') || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) throw new BackendV2Error('PATH_INVALID', 'unsafe relative path');
  const canonicalRoot = await realpath(root);
  if ((await lstat(root)).isSymbolicLink()) throw new BackendV2Error('PATH_INVALID', 'symlinked root');
  const path = resolve(root, ...relativePath.split('/'));
  if (!inside(resolve(root), path)) throw new BackendV2Error('PATH_ESCAPE', 'path escapes owned root');
  let current = resolve(root);
  for (const part of relative(current, path).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new BackendV2Error('PATH_SYMLINK', 'symlinked path component');
  }
  const canonical = await realpath(path);
  if (!inside(canonicalRoot, canonical) || !(await stat(canonical)).isFile()) throw new BackendV2Error('PATH_ESCAPE', 'file is not confined to root');
  return canonical;
}

async function measuredFile(root: string, relativePath: string): Promise<{ path: string; sha256: string; bytes: number }> {
  const path = await actualFile(root, relativePath);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size <= 0) throw new BackendV2Error('FILE_INVALID', 'file is not a nonempty regular file');
    const bytes = await handle.readFile();
    return { path, sha256: sha(bytes), bytes: bytes.byteLength };
  } finally { await handle.close(); }
}

async function evidence(root: string, path: string, expectedSha256?: string): Promise<Uint8Array> {
  const measured = await measuredFile(root, path);
  if (expectedSha256 && measured.sha256 !== expectedSha256) throw new BackendV2Error('EVIDENCE_HASH_MISMATCH', `evidence digest differs: ${path}`);
  return readFile(measured.path);
}

async function writeEvidence(root: string, path: string, value: unknown): Promise<{ relativePath: string; sha256: string }> {
  return writeEvidenceBytes(root, path, Buffer.from(canonicalize(value)));
}

async function writeEvidenceBytes(root: string, path: string, bytes: Buffer): Promise<{ relativePath: string; sha256: string }> {
  const checks = resolve(root, 'checks');
  if (!path.startsWith('checks/') || !inside(checks, resolve(root, ...path.split('/')))) throw new BackendV2Error('EVIDENCE_PATH_INVALID', 'proof path must stay in checks');
  await mkdir(checks, { recursive: true });
  if ((await lstat(checks)).isSymbolicLink() || await realpath(checks) !== checks) throw new BackendV2Error('EVIDENCE_PATH_INVALID', 'checks directory is not canonical');
  const destination = resolve(root, ...path.split('/'));
  const handle = await open(destination, 'wx');
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  if ((await measuredFile(root, path)).sha256 !== sha(bytes)) throw new BackendV2Error('EVIDENCE_WRITE_FAILED', 'persisted proof differs from written bytes');
  return { relativePath: path, sha256: sha(bytes) };
}

async function readJson(root: string, relativePath: string, digest?: string): Promise<unknown> {
  const bytes = await evidence(root, relativePath, digest);
  try { return JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown; }
  catch { throw new BackendV2Error('EVIDENCE_INVALID', `invalid JSON: ${relativePath}`); }
}

function same(left: unknown, right: unknown): boolean { return canonicalize(left) === canonicalize(right); }
function identity(input: Identity) { return { schemaVersion: 2 as const, jobId: input.jobId, assetId: input.assetId, attempt: input.attempt, operationId: input.operationId }; }
function assertValid(result: { success: boolean }, code: string): void { if (!result.success) throw new BackendV2Error(code, code); }

async function traceRecords(root: string, relativePath: string): Promise<CanonicalTraceRecord[]> {
  return (await evidence(root, relativePath)).toString().trim().split('\n').map((line) => JSON.parse(line) as CanonicalTraceRecord);
}

function containsField(value: unknown, name: RegExp, expected: string): boolean {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) =>
    (name.test(key) && child === expected) || containsField(child, name, expected));
}

async function verifyObservedUse(
  root: string, request: RenderRequestV2, rendered: RenderedOwned,
  sourcePath: string, templatePath: string, templatePreSha256: string,
  journal: OperationJournal,
): Promise<void> {
  const documents = await traceRecords(root, rendered.evidence.documentTracePath);
  const pre = documents.find((record) => record.phase === 'pre' && record.event === 'document-content');
  const openIssued = documents.find((record) => record.phase === 'event' && record.detail?.type === 'operation' && record.detail.operation === 'openDocument' && record.detail.state === 'issued');
  const openAcknowledged = documents.find((record) => record.phase === 'event' && record.detail?.type === 'state-transition' && record.detail.operation === 'openDocument' && record.detail.transition === 'acknowledged' && record.sequence > (openIssued?.sequence ?? Infinity));
  const proof = documents.find((record) => record.phase === 'event' && record.detail?.type === 'ownership-proof' &&
    record.detail.owned === true && record.detail.provisional === false && record.detail.parentId === null &&
    record.detail.expectedParentId === null && record.detail.expectedPath === templatePath &&
    record.detail.documentId === record.detail.activeDocumentId &&
    record.sequence > (openAcknowledged?.sequence ?? Infinity));
  if (!pre || pre.sha256 !== templatePreSha256 || !openIssued || openIssued.detail?.documentId !== templatePath ||
      !openAcknowledged || !proof || !proof.detail?.documentId) {
    throw new BackendV2Error('OPEN_TRACE_UNPROVEN', 'document trace does not prove the exact owned template open');
  }
  const documentsId = proof.detail.documentId;
  const entries = await journal.read();
  const terminal = new Map(entries.map((entry) => [entry.requestId, entry]));
  const placements = [...terminal.values()].filter((entry) => (entry.operation === 'place' || entry.operation === 'replaceContents') && entry.state === 'acknowledged');
  const tools = await traceRecords(root, rendered.evidence.toolTracePath);
  let sourceObserved = false;
  for (const placement of placements) {
    const record = tools.find((candidate) => candidate.phase === 'pre' && candidate.requestId === placement.requestId);
    if (!record?.path || !record.sha256) continue;
    const call = await readJson(root, record.path, record.sha256) as { requestId?: unknown; toolName?: unknown; arguments?: unknown };
    if (call.requestId !== placement.requestId || call.toolName !== record.event) continue;
    if (containsField(call.arguments, /(?:path|source|input|asset|file)/i, sourcePath) &&
        containsField(call.arguments, /documentId/i, documentsId)) sourceObserved = true;
  }
  if (!sourceObserved) throw new BackendV2Error('PLACEMENT_TRACE_UNPROVEN', 'qualified placement trace does not use the exact owned source in the opened template document');
  if (request.operationId !== documents[0]?.operationId || request.operationId !== tools[0]?.operationId) throw new BackendV2Error('TRACE_OPERATION_MISMATCH', 'trace belongs to another V2 operation');
}

type RenderedOwned = {
  evidence: RenderEvidence;
  openedSourcePath: string;
  openedTemplatePath: string;
  quiescent: true;
  ownedDocumentsRemaining: 0;
};
type Context = Identity & {
  stagingDirectory: string; sourceRootPath: string; sourceRootIdentity: string; templateRoot: string;
  ownershipToken: string; previousPid: number; previousProcessStartIdentity: string;
  originals: Array<{ root: 'source' | 'template'; relativePath: string; sha256: string; bytes: number }>;
};
async function originalsUnchanged(context: Context): Promise<boolean> {
  for (const original of context.originals) {
    if (original.root !== 'source' && original.root !== 'template') return false;
    const measured = await measuredFile(original.root === 'source' ? context.sourceRootPath : context.templateRoot, original.relativePath);
    if (measured.sha256 !== original.sha256 || measured.bytes !== original.bytes) return false;
  }
  return true;
}
export type BackendV2Options = {
  base: Pick<PhotoshopBackendV2, 'capabilities' | 'inspect' | 'qualify'>;
  lock: SessionLock;
  templateLinks: QualifiedLinkOperation;
  templateRoot: string;
  templateRootId: string;
  contextRoot: string;
  renderOwned: (request: RenderRequestV2, ownedSourcePath: string, workingTemplatePath: string, signal: AbortSignal) => Promise<RenderedOwned>;
  recoveryRuntime: (request: RecoveryRequestV2, context: Context) => Promise<RecoveryRuntime>;
};

export const V2_PROOF_PATHS = {
  ownedInput: 'checks/owned-input-proof.json', templateClosure: 'checks/template-closure-proof.json',
  releaseOwner: 'checks/release-owner.json', releaseJournal: 'checks/release-journal.jsonl', release: 'checks/release-proof.json',
} as const;

export class PhotoshopBackendV2Adapter implements PhotoshopBackendV2 {
  constructor(private readonly options: BackendV2Options) {}
  capabilities(signal: AbortSignal) { return this.options.base.capabilities(signal); }
  inspect(templatePath: string, signal: AbortSignal) { return this.options.base.inspect(templatePath, signal); }
  qualify(request: Parameters<PhotoshopBackendV2['qualify']>[0], signal: AbortSignal) { return this.options.base.qualify(request, signal); }

  async prepareOwnedInput(value: PrepareRequestV2, signal: AbortSignal): Promise<PreparedInputManifestV2> {
    const request = PrepareRequestV2Schema.parse(value);
    // PSD/PSB linkage needs an installation-qualified, byte-bound reader. No
    // caller-provided link list is admitted as that capability in this release.
    const unavailable = { readLinks: async (): Promise<never> => { throw new BackendV2Error('LINK_SCAN_UNAVAILABLE', 'qualified PSD/PSB link scan is unavailable'); } };
    return this.options.lock.runExclusive(request.operationId, () => prepareOwnedInputV2(request, unavailable, signal), signal);
  }

  async render(value: RenderRequestV2, signal: AbortSignal): Promise<RenderEvidenceV2> {
    const request = RenderRequestV2Schema.parse(value);
    const root = await realpath(request.stagingDirectory);
    if (root !== resolve(request.stagingDirectory) || (await lstat(root)).isSymbolicLink()) throw new BackendV2Error('STAGING_ROOT_INVALID', 'staging root is not canonical');
    const prepared = await readJson(root, PREPARED_INPUT_MANIFEST_V2_PATH);
    const manifest = validatePreparedInputManifestV2(prepared, {
      schemaVersion: 2, jobId: request.jobId, asset: request.asset, profile: request.profile,
      attempt: request.attempt, operationId: request.operationId, stagingDirectory: request.stagingDirectory,
      scratchDirectory: request.ownedInput.scratchDirectory,
      sourceRoot: {
        rootId: (prepared as PreparedInputManifestV2).sourceRootId,
        path: (prepared as PreparedInputManifestV2).sourceRootPath,
        identity: request.ownedInput.sourceRootIdentity,
      },
    });
    assertValid(manifest, 'PREPARATION_MISMATCH');
    if (!manifest.success || manifest.data.status !== 'prepared') throw new BackendV2Error('PREPARATION_BLOCKED', 'source was not prepared');
    assertValid(validateRenderRequestV2(request, manifest.data), 'RENDER_REQUEST_MISMATCH');
    const sourceRoot = await sourceRootIdentity(manifest.data.sourceRootPath);
    if (sourceRoot.identity !== request.ownedInput.sourceRootIdentity) throw new BackendV2Error('SOURCE_ROOT_CHANGED', 'source root identity changed');
    if (root === sourceRoot.root || inside(root, sourceRoot.root) || inside(sourceRoot.root, root)) throw new BackendV2Error('ROOT_OVERLAP', 'staging and original source roots overlap');
    const closure = await readJson(root, ASSET_CLOSURE_PROOF_V2_PATH, request.ownedInput.closureProof.sha256) as PreparedClosure;
    const expectedClosure = {
      schemaVersion: 2, jobId: request.jobId, assetId: request.asset.assetId, attempt: request.attempt,
      operationId: request.operationId, sourceRootIdentity: sourceRoot.identity,
      source: { relativePath: request.asset.source.relativePath, sha256: request.asset.source.sha256, bytes: request.asset.sourceBytes },
      dependencies: manifest.data.dependencies,
    };
    if (request.ownedInput.closureProof.relativePath !== ASSET_CLOSURE_PROOF_V2_PATH || closure.closureComplete !== true ||
      !same(Object.fromEntries(Object.entries(closure).filter(([key]) => key !== 'observedLinks' && key !== 'closureComplete')), expectedClosure) ||
      !Array.isArray(closure.observedLinks)) throw new BackendV2Error('CLOSURE_MISMATCH', 'persisted closure does not match the prepared asset');
    if (extname(request.asset.source.relativePath).toLowerCase() !== '.png' && !['.jpg', '.jpeg'].includes(extname(request.asset.source.relativePath).toLowerCase())) {
      throw new BackendV2Error('LINK_SCAN_UNQUALIFIED', 'PSD source requires code-owned qualified link scanning');
    }
    if (manifest.data.dependencies.length || closure.observedLinks.length) throw new BackendV2Error('LINK_SCAN_UNQUALIFIED', 'linked asset requires code-owned qualified link scanning');

    const entries = [
      { original: request.asset.source, ownedRelativePath: request.ownedInput.source.relativePath, bytes: request.asset.sourceBytes },
      ...request.ownedInput.dependencies.map((dependency) => ({ original: dependency.original, ownedRelativePath: dependency.relativePath, bytes: dependency.bytes })),
    ];
    const measured = await Promise.all(entries.map(async (entry) => {
      const original = await measuredFile(sourceRoot.root, entry.original.relativePath);
      const owned = await measuredFile(root, entry.ownedRelativePath);
      if (original.sha256 !== entry.original.sha256 || owned.sha256 !== entry.original.sha256 || original.bytes !== entry.bytes || owned.bytes !== entry.bytes) throw new BackendV2Error('OWNED_INPUT_CHANGED', 'source or owned copy differs from prepared bytes');
      return { ...entry, originalPath: original.path, ownedPath: owned.path, originalBeforeSha256: original.sha256, copyBeforeSha256: owned.sha256 };
    }));
    const openedSource = measured[0]!;
    const templateRoot = await realpath(this.options.templateRoot);
    if (root === templateRoot || inside(root, templateRoot) || inside(templateRoot, root) ||
        sourceRoot.root === templateRoot || inside(sourceRoot.root, templateRoot) || inside(templateRoot, sourceRoot.root)) {
      throw new BackendV2Error('ROOT_OVERLAP', 'template root overlaps staging or original source root');
    }
    const templateOriginal = await measuredFile(templateRoot, request.profile.template.relativePath);
    if (request.profile.template.rootId !== this.options.templateRootId || templateOriginal.sha256 !== request.profile.template.sha256) throw new BackendV2Error('TEMPLATE_CHANGED', 'qualified template differs from profile');
    const attemptRoot = resolve(root, request.ownedInput.scratchDirectory, 'template-v2');
    if (!inside(root, attemptRoot)) throw new BackendV2Error('TEMPLATE_PATH_INVALID', 'template attempt escapes staging');
    let rendered: RenderedOwned | undefined;
    let ownerSnapshot: { relativePath: string; sha256: string } | undefined;
    let journalSnapshot: { relativePath: string; sha256: string } | undefined;
    let ownedProof: { relativePath: string; sha256: string } | undefined;
    let templateProof: { relativePath: string; sha256: string } | undefined;
    await this.options.lock.runExclusive(request.operationId, async () => {
      const lockOwner = this.options.lock.journalMetadata;
      if (!lockOwner || lockOwner.operationId !== request.operationId) throw new BackendV2Error('LOCK_IDENTITY_MISMATCH', 'installation owner differs from operation');
      const context: Context = { jobId: request.jobId, assetId: request.asset.assetId, attempt: request.attempt, operationId: request.operationId,
        stagingDirectory: root, sourceRootPath: sourceRoot.root, sourceRootIdentity: sourceRoot.identity, templateRoot,
        ownershipToken: lockOwner.ownershipToken, previousPid: lockOwner.pid, previousProcessStartIdentity: lockOwner.processStartIdentity,
        originals: [
          ...measured.map((entry) => ({ root: 'source' as const, relativePath: entry.original.relativePath, sha256: entry.original.sha256, bytes: entry.bytes })),
          { root: 'template' as const, relativePath: request.profile.template.relativePath, sha256: templateOriginal.sha256, bytes: templateOriginal.bytes },
        ] };
      const contextRoot = await realpath(this.options.contextRoot);
      if (!(await stat(contextRoot)).isDirectory()) throw new BackendV2Error('CONTEXT_ROOT_INVALID', 'recovery context root is not a directory');
      if (contextRoot === sourceRoot.root || inside(sourceRoot.root, contextRoot) || inside(contextRoot, sourceRoot.root) ||
          contextRoot === templateRoot || inside(templateRoot, contextRoot) || inside(contextRoot, templateRoot)) {
        throw new BackendV2Error('ROOT_OVERLAP', 'recovery context overlaps an original root');
      }
      const contextPath = join(contextRoot, `${sha(request.operationId)}.json`);
      await writeEvidenceBytes(root, 'checks/recovery-context.json', Buffer.from(canonicalize(context)));
      const contextHandle = await open(contextPath, 'wx');
      try { await contextHandle.writeFile(canonicalize(context)); await contextHandle.sync(); } finally { await contextHandle.close(); }
      const working = await createWorkingCopy({ masterPath: templateOriginal.path, trustedRoot: templateRoot,
        attemptRoot, expectedMasterSha256: request.profile.template.sha256, operation: this.options.templateLinks });
      const workingTemplate = await realpath(working.masterPath);
      if (!inside(await realpath(working.attemptRoot), workingTemplate)) throw new BackendV2Error('TEMPLATE_COPY_INVALID', 'working template escaped attempt');
      rendered = await this.options.renderOwned(request, openedSource.ownedPath, workingTemplate, signal);
      const v1 = RenderEvidenceSchema.parse(rendered.evidence);
      if (!rendered.quiescent || rendered.ownedDocumentsRemaining !== 0 ||
        await realpath(rendered.openedSourcePath) !== openedSource.ownedPath || await realpath(rendered.openedTemplatePath) !== workingTemplate ||
        v1.jobId !== request.jobId || v1.assetId !== request.asset.assetId || v1.attempt !== request.attempt ||
        v1.profileSha256 !== request.profile.profileSha256 || v1.sourceSha256 !== request.asset.source.sha256 ||
        v1.toolSchemaSha256 !== request.profile.toolSchemaSha256) throw new BackendV2Error('RENDER_IDENTITY_MISMATCH', 'renderer evidence or opened document differs from verified owned paths');
      for (const path of [v1.documentTracePath, v1.toolTracePath]) await validateCanonicalTrace(root, path, request.operationId);
      if (v1.geometry.length !== request.profile.targets.length ||
          v1.geometry.some((item, index) => !same(item.target, request.profile.targets[index]?.target) || item.fitMode !== request.profile.fitMode || !item.clipped || !item.adjacentToReference) ||
          v1.visibility.length !== 3 || v1.visibility.some((item) => item.visibleVariantIds.length !== 1 || item.visibleVariantIds[0] !== item.variantId) ||
          new Set(v1.visibility.map((item) => item.variantId)).size !== 3 ||
          v1.checks.length < v1.geometry.length + 2 ||
          !['propagation', 'source-integrity', ...v1.geometry.map((_, index) => `geometry-${index + 1}`)].every((id) => v1.checks.some((check) => check.id === id && check.passed))) {
        throw new BackendV2Error('RENDER_QA_INCOMPLETE', 'renderer lacks complete geometry, visibility or mandatory checks');
      }
      for (const artifact of v1.artifacts) {
        const file = await measuredFile(root, artifact.path);
        if (file.sha256 !== artifact.sha256 || file.bytes !== artifact.bytes || artifact.format !== request.profile.output.format ||
            artifact.width !== request.profile.output.width || artifact.height !== request.profile.output.height) {
          throw new BackendV2Error('ARTIFACT_CHANGED', 'render artifact bytes or dimensions differ from evidence');
        }
        const decoded = await inspectExportFile(file.path, request.profile.output, request.profile.output.format === 'jpeg' ? 'opaque' : 'preserve');
        if (decoded.bytes !== artifact.bytes || decoded.width !== artifact.width || decoded.height !== artifact.height) throw new BackendV2Error('ARTIFACT_CHANGED', 'decoded export differs from reported artifact');
      }
      for (const check of v1.checks) {
        if (!check.passed) throw new BackendV2Error('CHECK_FAILED', 'renderer reported a failed check');
        const persisted = await readJson(root, check.evidencePath);
        if (!persisted || typeof persisted !== 'object' || (persisted as { id?: unknown }).id !== check.id || (persisted as { passed?: unknown }).passed !== true) {
          throw new BackendV2Error('CHECK_FAILED', 'persisted check does not corroborate renderer evidence');
        }
      }
      const originalAfter = await Promise.all(measured.map((entry) => measuredFile(sourceRoot.root, entry.original.relativePath)));
      const copyAfter = await Promise.all(measured.map((entry) => measuredFile(root, entry.ownedRelativePath)));
      if (originalAfter.some((file, index) => file.sha256 !== measured[index]!.originalBeforeSha256) || copyAfter.some((file, index) => file.sha256 !== measured[index]!.copyBeforeSha256)) throw new BackendV2Error('OWNED_INPUT_CHANGED', 'owned source or original changed during rendering');
      const copyProof = (index: number) => ({ original: measured[index]!.original, ownedRelativePath: measured[index]!.ownedRelativePath,
        bytes: measured[index]!.bytes, originalBeforeSha256: measured[index]!.originalBeforeSha256,
        originalAfterSha256: originalAfter[index]!.sha256, copyBeforeSha256: measured[index]!.copyBeforeSha256, copyAfterSha256: copyAfter[index]!.sha256 });
      const sourceProof = { ...identity({ jobId: request.jobId, assetId: request.asset.assetId, attempt: request.attempt, operationId: request.operationId }),
        sourceRootIdentity: sourceRoot.identity, openedSourceRelativePath: openedSource.ownedRelativePath,
        source: copyProof(0), dependencies: request.ownedInput.dependencies.map((dependency, index) => ({ ...copyProof(index + 1), identity: dependency.identity, sourceKind: 'linked' as const })),
        observedLinks: [], closureProof: request.ownedInput.closureProof };
      assertValid(validateOwnedInputProofV2(sourceProof, request, manifest.data), 'OWNED_PROOF_INVALID');
      ownedProof = await writeEvidence(root, V2_PROOF_PATHS.ownedInput, sourceProof);

      const templateEntries = await Promise.all(working.closure.map(async (entry) => {
        const original = await measuredFile(templateRoot, relative(templateRoot, entry.originalPath).split(sep).join('/'));
        const copy = await measuredFile(root, relative(root, entry.copyPath).split(sep).join('/'));
        if (original.sha256 !== entry.sha256 || entry.copyBeforeSha256 !== entry.sha256 ||
            (entry.copyAfterSha256 !== entry.copyBeforeSha256 && !entry.mutationAcknowledged)) {
          throw new BackendV2Error('TEMPLATE_CHANGED', 'template original or pre-render copy proof changed');
        }
        return { original: { rootId: this.options.templateRootId, relativePath: relative(templateRoot, entry.originalPath).split(sep).join('/'), sha256: entry.sha256 },
          ownedRelativePath: relative(root, entry.copyPath).split(sep).join('/'), bytes: original.bytes,
          originalBeforeSha256: entry.sha256, originalAfterSha256: original.sha256, copyBeforeSha256: entry.copyBeforeSha256, copyAfterSha256: copy.sha256,
          identity: entry.identity, sourceKind: entry.originalPath === templateOriginal.path ? 'template' as const : 'linked' as const };
      }));
      const byCopy = new Map(working.closure.map((entry) => [entry.copyPath, entry]));
      const templateEdges: Array<{ parentOwnedRelativePath: string; childOwnedRelativePath: string; identity: string }> = [];
      for (const parent of working.closure) {
        for (const link of await this.options.templateLinks.readLinks(parent.copyPath)) {
          if (link.sourceKind === 'embedded') continue;
          if (link.sourceKind !== 'linked' || !link.path) throw new BackendV2Error('TEMPLATE_LINK_UNKNOWN', 'template link could not be resolved');
          const childPath = await realpath(isAbsolute(link.path) ? link.path : resolve(dirname(parent.copyPath), link.path));
          if (!inside(working.attemptRoot, childPath)) throw new BackendV2Error('TEMPLATE_LINK_ESCAPE', 'working template still links outside its attempt root');
          const child = byCopy.get(childPath);
          if (!child) throw new BackendV2Error('TEMPLATE_CLOSURE_CHANGED', 'template link differs from copied closure');
          templateEdges.push({ parentOwnedRelativePath: relative(root, parent.copyPath).split(sep).join('/'),
            childOwnedRelativePath: relative(root, child.copyPath).split(sep).join('/'), identity: child.identity });
        }
      }
      const templateProofData = { ...identity({ jobId: request.jobId, assetId: request.asset.assetId, attempt: request.attempt, operationId: request.operationId }),
        template: request.profile.template, workingTemplateRelativePath: relative(root, workingTemplate).split(sep).join('/'),
        closureEntries: templateEntries, observedLinks: templateEdges,
        documentTrace: { relativePath: v1.documentTracePath, sha256: (await measuredFile(root, v1.documentTracePath)).sha256 } };
      assertValid(validateTemplateClosureProofV2(templateProofData, request), 'TEMPLATE_PROOF_INVALID');
      templateProof = await writeEvidence(root, V2_PROOF_PATHS.templateClosure, templateProofData);
      const journalPath = this.options.lock.journalPath;
      const journalBytes = await readFile(journalPath);
      if (!journalBytes.byteLength) throw new BackendV2Error('JOURNAL_MISSING', 'renderer did not persist operation journal');
      const auditedJournal = new OperationJournal(journalPath, this.options.lock.journalIdentity ?? undefined);
      await auditedJournal.read();
      const lockState = this.options.lock.journalMetadata;
      if (auditedJournal.pendingUnknown().length || !lockState || lockState.unknownMutation || lockState.unsettledOperations !== 0 || !lockState.reconciledJobOwnedDocuments) {
        await this.options.lock.markUnknownMutation();
        throw new BackendV2Error('JOURNAL_UNSETTLED', 'render journal or transport has an unresolved operation');
      }
      await verifyObservedUse(root, request, rendered, openedSource.ownedPath, workingTemplate, working.closure.find((entry) => entry.originalPath === templateOriginal.path)!.copyAfterSha256, auditedJournal);
      ownerSnapshot = await writeEvidence(root, V2_PROOF_PATHS.releaseOwner, lockState);
      journalSnapshot = await writeEvidenceBytes(root, V2_PROOF_PATHS.releaseJournal, journalBytes);
    }, signal);
    if (!rendered || !ownerSnapshot || !journalSnapshot || !ownedProof || !templateProof || this.options.lock.journalMetadata) throw new BackendV2Error('RELEASE_UNCONFIRMED', 'render did not confirm installation release');
    const release = { ...identity({ jobId: request.jobId, assetId: request.asset.assetId, attempt: request.attempt, operationId: request.operationId }),
      released: true as const, ownerIdentitySha256: ownerSnapshot.sha256, journalSha256: journalSnapshot.sha256,
      ownerSnapshot, journalSnapshot };
    assertValid(validateReleaseProofV2(release, identity({ jobId: request.jobId, assetId: request.asset.assetId, attempt: request.attempt, operationId: request.operationId })), 'RELEASE_PROOF_INVALID');
    const releaseProof = await writeEvidence(root, V2_PROOF_PATHS.release, release);
    const { schemaVersion: _schemaVersion, ...v1 } = rendered.evidence;
    const result = { ...v1, schemaVersion: 2 as const, operationId: request.operationId, ownedInputProof: ownedProof,
      templateClosureProof: templateProof, released: true as const, releaseProof };
    assertValid(validateRenderEvidenceV2(result, request), 'RENDER_EVIDENCE_INVALID');
    return result;
  }
  async recover(value: RecoveryRequestV2, signal: AbortSignal): Promise<RecoveryResultV2> {
    const request = RecoveryRequestV2Schema.parse(value);
    const unsafe = (): RecoveryResultV2 => ({ ...request, safe: false, released: false, evidencePaths: [], releaseProof: null });
    let context: Context;
    try {
      const contextRoot = await realpath(this.options.contextRoot);
      const contextFile = await measuredFile(contextRoot, `${sha(request.operationId)}.json`);
      context = JSON.parse((await readFile(contextFile.path)).toString('utf8')) as Context;
      if (!same(identity(context), identity(request)) ||
          context.operationId !== request.operationId || !context.ownershipToken ||
          !Number.isInteger(context.previousPid) || !context.previousProcessStartIdentity ||
          !Array.isArray(context.originals) || context.originals.length < 2 ||
          await sourceRootIdentity(context.sourceRootPath).then((item) => item.identity) !== context.sourceRootIdentity ||
          await realpath(context.stagingDirectory) !== context.stagingDirectory ||
          await realpath(context.templateRoot) !== context.templateRoot) return unsafe();
      const persisted = await readJson(context.stagingDirectory, 'checks/recovery-context.json');
      if (!same(persisted, context)) return unsafe();
    } catch { return unsafe(); }
    try {
      if (!this.options.lock.journalMetadata) {
        await this.options.lock.adoptRecovery({ operationId: request.operationId,
          ownershipToken: context.ownershipToken, previousPid: context.previousPid,
          previousProcessStartIdentity: context.previousProcessStartIdentity });
      }
      const owner = this.options.lock.journalMetadata;
      if (!owner || owner.operationId !== request.operationId || owner.ownershipToken !== context.ownershipToken) return unsafe();
      let ownerSnapshot: { relativePath: string; sha256: string } | undefined;
      let journalSnapshot: { relativePath: string; sha256: string } | undefined;
      const result = await this.options.lock.runRecovery(async () => {
        const runtime = await this.options.recoveryRuntime(request, context);
        const lockIdentity = this.options.lock.journalIdentity;
        if (!lockIdentity || runtime.journalPath !== this.options.lock.journalPath ||
          !runtime.identity || !same(runtime.identity, { ...lockIdentity, jobRoot: context.stagingDirectory })) return unsafe();
        if (!await originalsUnchanged(context)) return unsafe();
        const recovered = await recoverJob(lockIdentity.jobId, runtime, signal);
        if (!recovered.safe) return unsafe();
        if (!await originalsUnchanged(context)) return unsafe();
        await this.options.lock.reconcile();
        ownerSnapshot = await writeEvidence(context.stagingDirectory, V2_PROOF_PATHS.releaseOwner, this.options.lock.journalMetadata);
        const journal = await readFile(this.options.lock.journalPath);
        if (!journal.byteLength) return unsafe();
        await new OperationJournal(this.options.lock.journalPath, lockIdentity).read();
        journalSnapshot = await writeEvidenceBytes(context.stagingDirectory, V2_PROOF_PATHS.releaseJournal, journal);
        return { ...request, safe: true, released: true, evidencePaths: [V2_PROOF_PATHS.release], releaseProof: { relativePath: V2_PROOF_PATHS.release, sha256: '0'.repeat(64) } };
      }, signal);
      if (!result.safe || !ownerSnapshot || !journalSnapshot || this.options.lock.journalMetadata) return unsafe();
      const release = { ...identity(request), released: true as const,
        ownerIdentitySha256: ownerSnapshot.sha256, journalSha256: journalSnapshot.sha256,
        ownerSnapshot, journalSnapshot };
      assertValid(validateReleaseProofV2(release, identity(request)), 'RELEASE_PROOF_INVALID');
      const ref = await writeEvidence(context.stagingDirectory, V2_PROOF_PATHS.release, release);
      const completed: RecoveryResultV2 = { ...request, safe: true, released: true, evidencePaths: [ref.relativePath], releaseProof: ref };
      assertValid(validateRecoveryResultV2(completed, request), 'RECOVERY_RESULT_INVALID');
      return completed;
    } catch { return unsafe(); }
  }
}

export function createPhotoshopBackendV2(options: BackendV2Options): PhotoshopBackendV2Adapter { return new PhotoshopBackendV2Adapter(options); }
