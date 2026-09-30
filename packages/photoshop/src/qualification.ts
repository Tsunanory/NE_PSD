import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import sharp from 'sharp';
import {
  CapabilityReportSchema,
  QualificationResultSchema,
  TemplateCandidateSchema,
  validateQualificationRequest as contractValidateQualificationRequest,
  type CapabilityReport,
  type ConfigurationProposal,
  type DomainError,
  type FileRef,
  type FitMode,
  type InspectionReport,
  type LayerSelector,
  type QualificationRequest,
  type QualificationResult,
  type Rect,
} from '@ne-psd/contracts';
import type { SessionLock } from './session-lock.js';
import { sha256 as hashFile } from './working-copy.js';

type LayerRef = string | { id?: string; [key: string]: unknown };
type CheckEvidence = { passed: boolean; evidencePath: string; details?: unknown };
export type SelectorProof = {
  preparedSha256: string;
  targets: Array<{ targetCandidateId: string; referenceCandidateId: string; inputCandidateId: string | null; target: LayerSelector; reference: LayerSelector; input: LayerSelector | null }>;
  variants: Array<{ candidateId: string; id: '1' | '2' | '3'; group: LayerSelector }>;
};

export type ClippingRelation = {
  inputId: string; referenceId: string; parentId: string | null; referenceParentId?: string | null;
  inputIndex: number; referenceIndex: number; clipped: boolean; baseId: string | null;
  kind?: 'pixel' | 'smartObject' | 'shape' | 'group' | 'unknown'; mask?: unknown; effects?: unknown; outerTransform?: unknown;
  maskSemantics?: 'alpha' | 'vector' | 'unknown'; layerCount?: number; uniqueNames?: boolean; requiresPreparation?: boolean;
};
export type ClippingAdapter = {
  inspectClipping?: (input: LayerRef, reference: LayerRef) => Promise<ClippingRelation>;
  readClipping?: (input: LayerRef, reference: LayerRef) => Promise<ClippingRelation>;
  moveAbove?: (input: LayerRef, reference: LayerRef) => Promise<unknown>;
  setClipping?: (input: LayerRef, reference: LayerRef, clipped: boolean) => Promise<unknown>;
  preparePixelInput?: (input: LayerRef, reference: LayerRef) => Promise<unknown>;
};
export type ClippingResult = { clipped: true; adjacentToReference: true; prepared?: boolean };

export class QualificationError extends Error {
  readonly name = 'QualificationError';
  constructor(readonly code: string, message: string, readonly category: DomainError['category'] = 'validation', readonly retryable = category === 'transient', readonly evidencePaths: readonly string[] = []) { super(message); }
}

function idOf(value: LayerRef): string { return typeof value === 'string' ? value : value.id ?? stable(value); }
function stable(value: unknown): string { return JSON.stringify(value, (_key, item) => item === undefined ? null : item); }
function same(a: unknown, b: unknown): boolean { return stable(a) === stable(b); }
function ack(value: unknown, operation: string): void { if (!value || typeof value !== 'object' || (value as { acknowledged?: unknown }).acknowledged !== true) throw new QualificationError(`${operation.toUpperCase()}_UNCERTAIN`, `${operation} did not return acknowledged:true`, 'ambiguousState'); }
function checkpoint(signal?: AbortSignal): void { if (signal?.aborted) throw new QualificationError('CANCELLED', 'qualification cancelled at a safe boundary', 'cancelled'); }
function reader(adapter: ClippingAdapter): (input: LayerRef, reference: LayerRef) => Promise<ClippingRelation> {
  const result = adapter.inspectClipping ?? adapter.readClipping; if (!result) throw new QualificationError('CLIPPING_CAPABILITY_MISSING', 'clipping inspection is not qualified', 'capability'); return result;
}
function correct(relation: ClippingRelation, inputId: string, referenceId: string): boolean {
  return relation.inputId === inputId && relation.referenceId === referenceId && relation.inputIndex === relation.referenceIndex - 1 && relation.clipped === true && relation.baseId === referenceId && relation.maskSemantics !== 'unknown' && relation.uniqueNames !== false;
}

export async function ensureClipping(adapter: ClippingAdapter, input: LayerRef, reference: LayerRef, signal?: AbortSignal): Promise<ClippingResult> {
  const read = reader(adapter); const inputId = idOf(input); const referenceId = idOf(reference); const before = await read(input, reference);
  if (correct(before, inputId, referenceId)) return { clipped: true, adjacentToReference: true };
  if (before.baseId !== null && before.baseId !== referenceId) throw new QualificationError('CLIPPING_WRONG_BASE', 'input is clipped to a different base');
  if (before.maskSemantics === 'unknown' || (before.kind === 'shape' && before.maskSemantics !== 'vector')) throw new QualificationError('CLIPPING_MASK_UNPROVEN', 'mask semantics are not proven', 'capability');
  const original = { mask: before.mask, effects: before.effects, outerTransform: before.outerTransform, layerCount: before.layerCount, uniqueNames: before.uniqueNames, parentId: before.parentId, referenceParentId: before.referenceParentId };
  let current: LayerRef = input; let prepared = false;
  if (before.kind === 'pixel' && before.requiresPreparation === true) {
    if (!adapter.preparePixelInput) throw new QualificationError('CLIPPING_PREPARATION_MISSING', 'pixel preparation primitive is missing', 'capability');
    checkpoint(signal); const result = await adapter.preparePixelInput(input, reference); ack(result, 'preparePixelInput'); checkpoint(signal); prepared = true;
  }
  let after = await read(current, reference);
  if (after.parentId !== original.parentId || (after.referenceParentId ?? original.referenceParentId) !== original.referenceParentId) throw new QualificationError('CLIPPING_PARENT_CHANGED', 'clipping preparation changed sibling ownership');
  if (after.inputIndex !== after.referenceIndex - 1) {
    if (!adapter.moveAbove) throw new QualificationError('CLIPPING_ADJACENCY_UNSUPPORTED', 'move-above primitive is missing', 'capability');
    checkpoint(signal); ack(await adapter.moveAbove(current, reference), 'moveAbove'); checkpoint(signal); after = await read(current, reference);
  }
  if (after.inputIndex !== after.referenceIndex - 1) throw new QualificationError('CLIPPING_NOT_ADJACENT', 'input is not immediately above reference');
  if (after.clipped !== true || after.baseId !== referenceId) {
    if (!adapter.setClipping) throw new QualificationError('CLIPPING_CAPABILITY_MISSING', 'set-clipping primitive is missing', 'capability');
    checkpoint(signal); ack(await adapter.setClipping(current, reference, true), 'setClipping'); checkpoint(signal); after = await read(current, reference);
  }
  if (!correct(after, idOf(current), referenceId)) throw new QualificationError('CLIPPING_VERIFICATION_FAILED', 'clipping relation did not verify');
  if (original.layerCount !== after.layerCount) throw new QualificationError('CLIPPING_LAYER_ACCUMULATION', 'layer count changed while preparing clipping');
  if (!same(original.mask, after.mask) || !same(original.effects, after.effects) || !same(original.outerTransform, after.outerTransform) || original.uniqueNames !== after.uniqueNames) throw new QualificationError('CLIPPING_TEMPLATE_EFFECTS_CHANGED', 'mask, effects, transform or names changed');
  return { clipped: true, adjacentToReference: true, ...(prepared ? { prepared: true } : {}) };
}

export type SentinelImagePrimitive = (path: string) => Promise<void>;
export type QualificationExporter = (input: { variantId: '1' | '2' | '3'; sentinelPath: string; evidenceDirectory: string; workingTemplatePath: string }) => Promise<{ path: string }>;
export type SentinelBaselineRecord = { targetId: string; region: Rect; path: string; bytes: number; sha256: string };
export type SentinelBaseline = { records: readonly SentinelBaselineRecord[] };
export type SentinelCorrespondence = { targetId: string; region: Rect; baselinePath: string; baselineBytes: number; baselineSha256: string; outputPath: string; outputBytes: number; outputSha256: string; evidencePath: string; passed: true };
export type SentinelPropagationResult = { writes: Array<{ identity: string; target: string }>; routes: string[]; equivalentTargets: Record<string, string[]> };
export type ContentAdapter = { getContentIdentity: (target: string) => Promise<string>; writeContent: (identity: string, sentinelPath: string) => Promise<unknown> };

export async function propagateSentinelByIdentity(adapter: ContentAdapter, targets: readonly string[], sentinelPath: string, signal?: AbortSignal): Promise<SentinelPropagationResult> {
  const writes: Array<{ identity: string; target: string }> = []; const equivalentTargets: Record<string, string[]> = {};
  if (targets.length === 0) throw new QualificationError('CONTENT_ROUTES_MISSING', 'no target routes were supplied');
  for (const target of targets) {
    const identity = await adapter.getContentIdentity(target); if (!identity || typeof identity !== 'string') throw new QualificationError('CONTENT_IDENTITY_MISSING', `unknown content identity for ${target}`);
    (equivalentTargets[identity] ??= []).push(target);
    if (!writes.some((write) => write.identity === identity)) { checkpoint(signal); const result = await adapter.writeContent(identity, sentinelPath); checkpoint(signal); ack(result, 'writeContent'); writes.push({ identity, target }); }
  }
  return { writes, routes: [...targets], equivalentTargets };
}

export type QualificationObservation = {
  preparedTemplatePath?: string; changed?: boolean; noChangeProof?: { acknowledged: true }; selectorProof?: SelectorProof;
  geometry?: CheckEvidence; linkage?: CheckEvidence; clipping?: CheckEvidence; identity?: CheckEvidence; propagation?: CheckEvidence;
};
export type ClosureEntry = { originalPath: string; sha256: string };
export type WorkingCopyResult = { path: string; closure: readonly ClosureEntry[]; noChangeProof?: { acknowledged: true }; verifyOriginals: () => Promise<boolean>; cleanup: () => Promise<void> };
export type RuntimeVisibility = { visibleVariantIds: readonly ('1' | '2' | '3')[] };
export type QualificationAdapter = {
  lock: Pick<SessionLock, 'runExclusive'> & Partial<Pick<SessionLock, 'markUnknownMutation'>>;
  capabilities: () => Promise<unknown>;
  createWorkingCopy: (input: { masterPath: string; evidenceDirectory: string; signal?: AbortSignal }) => Promise<WorkingCopyResult>;
  snapshot: (label: string) => Promise<unknown>;
  prepare?: (input: { workingTemplatePath: string; evidenceDirectory: string; signal?: AbortSignal }) => Promise<QualificationObservation>;
  savePreparedCopy?: (path: string) => Promise<unknown>;
  reopenPreparedCopy?: (path: string) => Promise<unknown>;
  resolveSelectors: (input: { workingTemplatePath: string; inspection: InspectionReport; proposal: ConfigurationProposal }) => Promise<SelectorProof>;
  verifyGeometry: (fitMode: FitMode, targetRoutes: readonly string[]) => Promise<CheckEvidence>;
  verifyLinkage: () => Promise<CheckEvidence>;
  verifyClipping: () => Promise<CheckEvidence>;
  getContentIdentity?: (target: string) => Promise<string>;
  writeContent?: (identity: string, sentinelPath: string) => Promise<unknown>;
  savePropagation?: () => Promise<unknown>;
  reopenPropagation?: () => Promise<unknown>;
  exporter: QualificationExporter;
  captureSentinelBaseline?: (targets: readonly string[], evidenceDirectory: string) => Promise<SentinelBaseline>;
  verifySentinelCorrespondence?: (input: { variantId: '1' | '2' | '3'; sentinelPath: string; outputPath: string; baseline: SentinelBaselineRecord }) => Promise<SentinelCorrespondence>;
  setVariantVisibility: (variantId: '1' | '2' | '3') => Promise<unknown>;
  readVariantVisibility: () => Promise<RuntimeVisibility>;
  cleanup: () => Promise<void>;
  render?: (...args: unknown[]) => Promise<unknown>;
  inspectClipping?: ClippingAdapter['inspectClipping']; readClipping?: ClippingAdapter['readClipping']; moveAbove?: ClippingAdapter['moveAbove']; setClipping?: ClippingAdapter['setClipping']; preparePixelInput?: ClippingAdapter['preparePixelInput'];
};
export type QualificationOptions = { adapter: QualificationAdapter; sentinel?: SentinelImagePrimitive; approvedCapability: true; approvedTemplateRoots: readonly string[]; approvedEvidenceRoots: readonly string[] };

const domainError = (code: string, message: string, category: DomainError['category'] = 'validation', evidencePaths: string[] = [], source?: unknown): DomainError => {
  const value = source && typeof source === 'object' ? source as Record<string, unknown> : {};
  const inherited = Array.isArray(value.evidencePaths) ? value.evidencePaths.filter((path): path is string => typeof path === 'string') : [];
  const retryable = typeof value.retryable === 'boolean' ? value.retryable : category === 'transient';
  return { code, category, message, retryable, evidencePaths: [...new Set([...inherited, ...evidencePaths])] };
};
let activeQualificationOutput: NonNullable<QualificationRequest['proposal']['output']> | undefined;
function validateQualificationRequest(request: QualificationRequest): ReturnType<typeof contractValidateQualificationRequest> { activeQualificationOutput = request.proposal.output ?? undefined; return contractValidateQualificationRequest(request); }
const pathEscape = (path: string): boolean => path.includes('\0') || path.split(/[\\/]+/).includes('..');
const within = (root: string, target: string): boolean => { const value = relative(root, target); return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value)); };
async function existingCanonical(path: string): Promise<string> { return realpath(path); }
async function rootContains(roots: readonly string[], path: string, allowMissingLeaf = false): Promise<boolean> {
  if (path.includes('\0')) return false;
  for (const root of roots) {
    let canonicalRoot: string;
    try { canonicalRoot = await existingCanonical(root); } catch { continue; }
    if ((await lstat(root)).isSymbolicLink()) continue;
    if (allowMissingLeaf) {
      let target: string;
      try { target = resolve(await realpath(dirname(path)), basename(path)); } catch { continue; }
      if (!within(canonicalRoot, target)) continue;
      if (!within(resolve(root), resolve(path))) continue;
      const parts = relative(resolve(root), resolve(path)).split(/[\\/]/).filter(Boolean); let current = resolve(root); let valid = true;
      for (let index = 0; index < parts.length; index += 1) {
        current = resolve(current, parts[index]!);
        try { const stat = await lstat(current); if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory()) || (index === parts.length - 1 && !stat.isDirectory())) valid = false; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || index !== parts.length - 1) valid = false; }
        if (!valid) break;
      }
      if (valid) return true;
    } else {
      try { if (within(canonicalRoot.toLocaleLowerCase(), (await existingCanonical(path)).toLocaleLowerCase())) return true; } catch { /* missing path */ }
    }
  }
  return false;
}
async function writeEvidence(root: string, relativePath: string, value: unknown): Promise<string> {
  if (pathEscape(relativePath) || relativePath.startsWith('/') || !within(resolve(root), resolve(root, relativePath))) throw new QualificationError('EVIDENCE_PATH_ESCAPE', `evidence path escapes trusted root: ${relativePath}`);
  const rootStat = await lstat(root); if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new QualificationError('EVIDENCE_PATH_ESCAPE', 'evidence root changed before writing');
  const canonicalRoot = await realpath(root); const parts = relative(canonicalRoot, resolve(canonicalRoot, relativePath)).split(/[\\/]/).filter(Boolean); let current = canonicalRoot;
  for (let index = 0; index < parts.length; index += 1) {
    current = resolve(current, parts[index]!);
    try { const stat = await lstat(current); if (stat.isSymbolicLink()) throw new QualificationError('EVIDENCE_PATH_ESCAPE', 'evidence path traverses a symlink'); if (index < parts.length - 1 && !stat.isDirectory()) throw new QualificationError('EVIDENCE_PATH_INVALID', 'evidence parent is not a directory'); }
    catch (error) { if (error instanceof QualificationError) throw error; if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; if (index === parts.length - 1) break; await mkdir(current); const made = await lstat(current); if (made.isSymbolicLink() || !made.isDirectory()) throw new QualificationError('EVIDENCE_PATH_ESCAPE', 'evidence parent could not be created safely'); }
  }
  const destination = resolve(canonicalRoot, relativePath); try { if ((await lstat(destination)).isSymbolicLink()) throw new QualificationError('EVIDENCE_PATH_ESCAPE', 'evidence destination is a symlink'); } catch (error) { if (error instanceof QualificationError) throw error; if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await writeFile(destination, typeof value === 'string' || value instanceof Uint8Array ? value : JSON.stringify(value, null, 2)); return relativePath;
}
async function canonicalExistingInside(root: string, targetPath: string): Promise<boolean> {
  if (targetPath.includes('\0')) return false;
  let canonicalRoot: string;
  try { canonicalRoot = await realpath(root); } catch { return false; }
  const lexicalRoot = resolve(root);
  const target = isAbsolute(targetPath) ? resolve(targetPath) : resolve(lexicalRoot, targetPath);
  if (!within(lexicalRoot, target)) return false;
  let canonicalTarget: string; try { canonicalTarget = await realpath(target); } catch { return false; }
  if (!within(canonicalRoot, canonicalTarget)) return false;
  const parts = relative(lexicalRoot, target).split(/[\\/]/).filter(Boolean); let current = lexicalRoot;
  for (const part of parts) {
    current = resolve(current, part);
    let stat; try { stat = await lstat(current); } catch { return false; }
    if (stat.isSymbolicLink()) return false;
  }
  try { return (await lstat(target)).isFile(); } catch { return false; }
}
async function ensureEvidenceRoot(path: string): Promise<string> {
  if (!isAbsolute(path) || path.includes('\0')) throw new QualificationError('EVIDENCE_PATH_ESCAPE', 'evidence directory must be an absolute path');
  const parent = dirname(path);
  const canonicalParent = await realpath(parent).catch(() => { throw new QualificationError('EVIDENCE_PATH_INVALID', 'evidence directory parent is unavailable'); });
  try {
    const rootStat = await lstat(path);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new QualificationError('EVIDENCE_PATH_INVALID', 'evidence directory must be a real directory');
  } catch (error) {
    if (error instanceof QualificationError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(path);
    const created = await lstat(path);
    if (created.isSymbolicLink() || !created.isDirectory()) throw new QualificationError('EVIDENCE_PATH_INVALID', 'evidence directory was redirected during creation');
  }
  const canonical = await realpath(path);
  if (!within(canonicalParent, canonical)) throw new QualificationError('EVIDENCE_PATH_ESCAPE', 'evidence directory canonical path is not stable');
  const parts = relative(canonicalParent, canonical).split(/[\\/]/).filter(Boolean); let current = canonicalParent;
  for (const part of parts) { current = resolve(current, part); const entry = await lstat(current); if (entry.isSymbolicLink() || !entry.isDirectory()) throw new QualificationError('EVIDENCE_PATH_INVALID', 'evidence directory contains a symlink component'); }
  return canonical;
}
async function verifiedFile(root: string, path: string, bytes: number, sha256: string): Promise<boolean> {
  if (!(await canonicalExistingInside(root, path)) || !Number.isInteger(bytes) || bytes <= 0 || !/^[a-f0-9]{64}$/.test(sha256)) return false;
  const data = await readFile(isAbsolute(path) ? path : resolve(root, path));
  return data.byteLength === bytes && createHash('sha256').update(data).digest('hex') === sha256;
}
function validRect(value: Rect): boolean { return Number.isFinite(value.left) && Number.isFinite(value.top) && Number.isFinite(value.right) && Number.isFinite(value.bottom) && value.right > value.left && value.bottom > value.top; }
function selectorsFromInspection(inspection: InspectionReport, proposal: ConfigurationProposal): SelectorProof {
  const byId = new Map(inspection.candidates.map((candidate) => [candidate.candidateId, candidate]));
  const targets = proposal.targets.map((target) => { const t = byId.get(target.targetCandidateId); const r = byId.get(target.referenceCandidateId); const i = target.inputCandidateId === null ? null : byId.get(target.inputCandidateId); if (!t || !r || (target.inputCandidateId !== null && !i)) throw new QualificationError('PROPOSAL_CANDIDATE_MISSING', 'proposal candidate is absent from inspection'); return { targetCandidateId: target.targetCandidateId, referenceCandidateId: target.referenceCandidateId, inputCandidateId: target.inputCandidateId, target: t.selector, reference: r.selector, input: i?.selector ?? null }; });
  const variants = proposal.variants.map((variant) => { const candidate = byId.get(variant.groupCandidateId); if (!candidate) throw new QualificationError('PROPOSAL_CANDIDATE_MISSING', 'proposal variant is absent from inspection'); return { candidateId: variant.groupCandidateId, id: variant.id, group: candidate.selector }; });
  return { preparedSha256: '', targets, variants };
}
function validSelectorProof(proof: SelectorProof, preparedSha256: string, inspection: InspectionReport, proposal: ConfigurationProposal): boolean {
  const expected = new Set(inspection.candidates.map((candidate) => candidate.candidateId)); const targetIds = new Set(proposal.targets.map((target) => target.targetCandidateId));
  if (targetIds.size !== proposal.targets.length || new Set(proof.targets.map((target) => target.targetCandidateId)).size !== proof.targets.length) return false;
  if (proof.preparedSha256 !== preparedSha256 || proof.targets.length !== proposal.targets.length || proof.variants.length !== 3) return false;
  if (proof.targets.some((target) => !expected.has(target.targetCandidateId) || !targetIds.has(target.targetCandidateId) || !expected.has(target.referenceCandidateId) || (target.inputCandidateId !== null && !expected.has(target.inputCandidateId)))) return false;
  if (proof.variants.some((variant) => !expected.has(variant.candidateId))) return false;
  const byId = new Map(inspection.candidates.map((candidate) => [candidate.candidateId, candidate.selector]));
  const proposalByTarget = new Map(proposal.targets.map((target) => [target.targetCandidateId, target]));
  if (proof.targets.some((target) => { const expectedTarget = proposalByTarget.get(target.targetCandidateId); return !expectedTarget || target.referenceCandidateId !== expectedTarget.referenceCandidateId || target.inputCandidateId !== expectedTarget.inputCandidateId || !same(target.target, byId.get(target.targetCandidateId)) || !same(target.reference, byId.get(target.referenceCandidateId)) || (target.inputCandidateId !== null && !same(target.input, byId.get(target.inputCandidateId))); })) return false;
  const proposalVariants = new Map(proposal.variants.map((variant) => [variant.id, variant]));
  if (proof.variants.some((variant) => !proposalVariants.has(variant.id) || proposalVariants.get(variant.id)!.groupCandidateId !== variant.candidateId || !same(variant.group, byId.get(variant.candidateId)))) return false;
  return new Set(proof.variants.map((variant) => variant.id)).size === 3;
}
function fileRef(path: string, sha256: string, rootId: string): FileRef { return { rootId, relativePath: `prepared/${path.split(/[\\/]/).at(-1) ?? 'template.psd'}`, sha256 }; }
function candidate(request: QualificationRequest, template: FileRef, selectors: SelectorProof, capabilities: CapabilityReport): unknown {
  return TemplateCandidateSchema.parse({ schemaVersion: 1, profileId: `candidate-${request.inspection.inspectionId}`, template, backendId: capabilities.backendId, toolSchemaSha256: capabilities.toolSchemaSha256, targets: selectors.targets.map((target) => ({ target: target.target, reference: target.reference, input: target.input })), fitMode: request.proposal.fitMode, output: request.proposal.output, variants: selectors.variants.map((variant) => ({ id: variant.id, group: variant.group })) });
}
function blocked(errors: DomainError[], checks: Array<{ id: string; passed: boolean; evidencePath: string }>, evidencePaths: string[]): QualificationResult { return QualificationResultSchema.parse({ status: 'blocked', candidate: null, checks, evidencePaths, errors }); }
async function sentinel(path: string): Promise<void> { const pixels = Buffer.alloc(32 * 32 * 4); const put = (x: number, y: number, color: [number, number, number, number]) => pixels.set(color, (y * 32 + x) * 4); put(0, 0, [240, 32, 32, 255]); put(31, 0, [32, 220, 64, 255]); put(0, 31, [48, 96, 240, 255]); put(31, 31, [240, 200, 32, 255]); for (let i = 8; i < 24; i += 1) { put(15, i, [255, 255, 255, 255]); put(16, i, [255, 255, 255, 255]); put(i, 15, [255, 255, 255, 255]); put(i, 16, [255, 255, 255, 255]); } await mkdir(resolve(path, '..'), { recursive: true }); await sharp(pixels, { raw: { width: 32, height: 32, channels: 4 } }).png().toFile(path); }
function closeColor(actual: number, expected: number): boolean { return Math.abs(actual - expected) <= 16; }
async function inspectExport(path: string, variantId: '1' | '2' | '3', output: NonNullable<QualificationRequest['proposal']['output']> = activeQualificationOutput ?? { format: 'png', width: 32, height: 32, colorSpace: 'sRGB', quality: 90 }): Promise<string> {
  const metadata = await sharp(path).metadata();
  if (metadata.format !== output.format || metadata.width !== output.width || metadata.height !== output.height) throw new QualificationError('SENTINEL_OUTPUT_POLICY_FAILED', `variant ${variantId} dimensions or format do not match the qualified output policy`);
  const image = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); const { data, info } = image; if (info.width < 4 || info.height < 4 || info.channels !== 4) throw new QualificationError('SENTINEL_IMAGE_INVALID', `variant ${variantId} is not a decoded RGBA image`);
  const pixels = (x: number, y: number) => { const at = (y * info.width + x) * 4; return [data[at]!, data[at + 1]!, data[at + 2]!, data[at + 3]!] as const; };
  const corners = [[pixels(0, 0), [240, 32, 32]], [pixels(info.width - 1, 0), [32, 220, 64]], [pixels(0, info.height - 1), [48, 96, 240]], [pixels(info.width - 1, info.height - 1), [240, 200, 32]]] as const;
  for (const [pixel, expected] of corners) if (!closeColor(pixel[0], expected[0]) || !closeColor(pixel[1], expected[1]) || !closeColor(pixel[2], expected[2]) || pixel[3] < 240) throw new QualificationError('SENTINEL_ORIENTATION_FAILED', `variant ${variantId} has wrong corner orientation or alpha`);
  const center = pixels(Math.floor(info.width / 2), Math.floor(info.height / 2)); if (center[0] < 220 || center[1] < 220 || center[2] < 220 || center[3] < 240) throw new QualificationError('SENTINEL_CROSS_FAILED', `variant ${variantId} center cross is absent`);
  if (!data.some((value, index) => index % 4 === 3 && value === 0)) throw new QualificationError('SENTINEL_ALPHA_HOLE_FAILED', `variant ${variantId} has no transparent hole`);
  if (data.reduce((count, value, index) => count + (index % 4 === 3 && value > 0 ? 1 : 0), 0) < 16) throw new QualificationError('SENTINEL_COVERAGE_FAILED', `variant ${variantId} target region coverage is absent`);
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

export async function qualify(request: QualificationRequest, signal: AbortSignal, options: QualificationOptions): Promise<QualificationResult>;
export async function qualify(request: QualificationRequest, options: QualificationOptions, signal?: AbortSignal): Promise<QualificationResult>;
export async function qualify(request: QualificationRequest, second: AbortSignal | QualificationOptions, third?: QualificationOptions | AbortSignal): Promise<QualificationResult> {
  const signal = second instanceof AbortSignal ? second : third instanceof AbortSignal ? third : undefined; const options = (second instanceof AbortSignal ? third : second) as QualificationOptions; const validation = validateQualificationRequest(request);
  if (!validation.success) return blocked([domainError('QUALIFICATION_REQUEST_INVALID', validation.error.message)], [], []);
  if (options.approvedCapability !== true) return blocked([domainError('CAPABILITY_NOT_ACKNOWLEDGED', 'approvedCapability:true is required', 'capability')], [], []);
  if (!await rootContains(options.approvedTemplateRoots, request.workingTemplatePath) || !await rootContains(options.approvedEvidenceRoots, request.evidenceDirectory, true)) return blocked([domainError('PATH_ESCAPE', 'qualification paths are outside approved canonical roots')], [], []);
  if (request.inspection.unresolvedLinks.length > 0) return blocked([domainError('LINKED_SOURCE_UNISOLATED', 'inspection contains unresolved links', 'capability')], [], []);
  const adapter = options.adapter; const evidencePaths: string[] = []; const checks: Array<{ id: string; passed: boolean; evidencePath: string }> = [];
  const execute = async (): Promise<QualificationResult> => {
    let copy: WorkingCopyResult | undefined; let transactionCleaned = false; let copyCleaned = false; let originalMaster = '';
    const clean = async (): Promise<void> => {
      let failure: unknown;
      // Cleanup is mandatory even after caller cancellation. Cancellation
      // checkpoints belong before mutations, never around the cleanup proof.
      if (!transactionCleaned) { transactionCleaned = true; try { await adapter.cleanup(); } catch (cause) { failure = cause; } }
      if (copy && !copyCleaned) { copyCleaned = true; try { await copy.cleanup(); } catch (cause) { failure ??= cause; } }
      if (failure) throw failure;
    };
    try {
      checkpoint(signal); await ensureEvidenceRoot(request.evidenceDirectory); if (!await rootContains(options.approvedEvidenceRoots, request.evidenceDirectory, true)) throw new QualificationError('EVIDENCE_PATH_ESCAPE', 'evidence directory changed before qualification'); const runtimeCapabilities = CapabilityReportSchema.parse(await adapter.capabilities()); const expected = request.inspection.capabilities;
      if (!expected || stable(runtimeCapabilities) !== stable(expected)) throw new QualificationError('CAPABILITY_STALE', 'runtime capability evidence does not exactly match inspection', 'capability');
      if (request.proposal.status !== 'proposed' || request.proposal.output === null) throw new QualificationError('PROPOSAL_INCOMPLETE', 'complete proposed output is required');
      await mkdir(request.evidenceDirectory, { recursive: true }); const pre = await adapter.snapshot('pre'); evidencePaths.push(await writeEvidence(request.evidenceDirectory, 'snapshots/pre.json', pre));
      originalMaster = await hashFile(request.workingTemplatePath); checkpoint(signal); copy = await adapter.createWorkingCopy({ masterPath: request.workingTemplatePath, evidenceDirectory: request.evidenceDirectory, ...(signal ? { signal } : {}) }); checkpoint(signal);
      if (!copy.path || !copy.closure || !copy.verifyOriginals || !copy.cleanup || copy.closure.some((entry) => !entry.originalPath || !/^[a-f0-9]{64}$/.test(entry.sha256)) || !await rootContains([request.evidenceDirectory], copy.path) || !copy.closure.some((entry) => entry.originalPath === request.workingTemplatePath && entry.sha256 === originalMaster)) throw new QualificationError('WORKING_COPY_UNVERIFIED', 'working-copy closure, authorization or cleanup proof is missing', 'capability');
      for (const entry of copy.closure) if (!await rootContains(options.approvedTemplateRoots, entry.originalPath)) throw new QualificationError('WORKING_COPY_CLOSURE_ESCAPE', 'linked source is outside approved template roots');
      const sentinelPath = resolve(request.evidenceDirectory, 'sentinel/source.png'); await (options.sentinel ?? sentinel)(sentinelPath); evidencePaths.push('sentinel/source.png'); checkpoint(signal);
      let preparation: QualificationObservation = {}; const preparedBefore = await hashFile(copy.path);
      if (adapter.prepare) { checkpoint(signal); preparation = await adapter.prepare({ workingTemplatePath: copy.path, evidenceDirectory: request.evidenceDirectory, ...(signal ? { signal } : {}) }); checkpoint(signal); if (preparation.changed !== true) throw new QualificationError('PREPARATION_CHANGE_UNPROVEN', 'prepared path requires explicit changed:true'); if (!adapter.savePreparedCopy || !adapter.reopenPreparedCopy) throw new QualificationError('PREPARATION_LIFECYCLE_MISSING', 'changed preparation requires save and reopen primitives', 'capability'); checkpoint(signal); ack(await adapter.savePreparedCopy(copy.path), 'savePreparedCopy'); checkpoint(signal); ack(await adapter.reopenPreparedCopy(copy.path), 'reopenPreparedCopy'); checkpoint(signal); }
      else if (copy.noChangeProof?.acknowledged !== true) throw new QualificationError('PREPARATION_STATE_UNKNOWN', 'already-prepared copy requires explicit no-change proof');
      const preparedSha = await hashFile(copy.path); if (adapter.prepare && preparedSha === preparedBefore) throw new QualificationError('PREPARATION_CHANGE_UNPROVEN', 'prepared changed:true did not change copied bytes'); const selectors = await adapter.resolveSelectors({ workingTemplatePath: copy.path, inspection: request.inspection, proposal: request.proposal }); if (!validSelectorProof(selectors, preparedSha, request.inspection, request.proposal)) throw new QualificationError('SELECTOR_PROVENANCE_INVALID', 'selectors were not regenerated for every supplied candidate');
      if (!adapter.captureSentinelBaseline || !adapter.verifySentinelCorrespondence) throw new QualificationError('SENTINEL_BASELINE_MISSING', 'true pre-mutation target-region and source-output correspondence primitives are required', 'capability');
      const baseline = await adapter.captureSentinelBaseline(selectors.targets.map((target) => target.targetCandidateId), request.evidenceDirectory); const baselineByTarget = new Map(baseline.records.map((record) => [record.targetId, record]));
      const baselineValid = baseline.records.length === selectors.targets.length && (await Promise.all(selectors.targets.map(async (target) => { const record = baselineByTarget.get(target.targetCandidateId); return Boolean(record && validRect(record.region) && await verifiedFile(request.evidenceDirectory, record.path, record.bytes, record.sha256)); }))).every(Boolean); if (!baselineValid) throw new QualificationError('SENTINEL_BASELINE_INVALID', 'pre-mutation target-region baseline is incomplete or hash-invalid');
      const geometry = await adapter.verifyGeometry(request.proposal.fitMode, selectors.targets.map((target) => target.targetCandidateId)); if (!geometry || geometry.passed !== true || !(await canonicalExistingInside(request.evidenceDirectory, geometry.evidencePath))) throw new QualificationError('GEOMETRY_EVIDENCE_INVALID', 'measured geometry evidence is missing'); evidencePaths.push(geometry.evidencePath); checks.push({ id: 'geometry', passed: true, evidencePath: geometry.evidencePath });
      const linkage = await adapter.verifyLinkage(); if (!linkage || linkage.passed !== true || !(await canonicalExistingInside(request.evidenceDirectory, linkage.evidencePath))) throw new QualificationError('LINKAGE_EVIDENCE_INVALID', 'linkage evidence is missing'); evidencePaths.push(linkage.evidencePath); checks.push({ id: 'linkage', passed: true, evidencePath: linkage.evidencePath });
      if (!adapter.inspectClipping && !adapter.readClipping) throw new QualificationError('CLIPPING_CAPABILITY_MISSING', 'clipping operation is not qualified', 'capability');
      const clippingAdapter: ClippingAdapter = {}; if (adapter.inspectClipping) clippingAdapter.inspectClipping = adapter.inspectClipping; if (adapter.readClipping) clippingAdapter.readClipping = adapter.readClipping; if (adapter.moveAbove) clippingAdapter.moveAbove = adapter.moveAbove; if (adapter.setClipping) clippingAdapter.setClipping = adapter.setClipping; if (adapter.preparePixelInput) clippingAdapter.preparePixelInput = adapter.preparePixelInput;
      for (const target of selectors.targets) await ensureClipping(clippingAdapter, target.input ?? target.target, target.reference, signal);
      const clipping = await adapter.verifyClipping(); if (!clipping || clipping.passed !== true || !(await canonicalExistingInside(request.evidenceDirectory, clipping.evidencePath))) throw new QualificationError('CLIPPING_EVIDENCE_INVALID', 'clipping evidence is missing'); evidencePaths.push(clipping.evidencePath); checks.push({ id: 'clipping', passed: true, evidencePath: clipping.evidencePath });
      if (!adapter.getContentIdentity || !adapter.writeContent || !adapter.savePropagation || !adapter.reopenPropagation) throw new QualificationError('PROPAGATION_CAPABILITY_MISSING', 'resource identity, acknowledged write/save/reopen operations are required', 'capability');
      const propagation = await propagateSentinelByIdentity({ getContentIdentity: adapter.getContentIdentity, writeContent: adapter.writeContent }, selectors.targets.map((target) => target.targetCandidateId), sentinelPath, signal); if (propagation.writes.length === 0) throw new QualificationError('CONTENT_WRITES_MISSING', 'no content resource was written'); checkpoint(signal); ack(await adapter.savePropagation(), 'savePropagation'); checkpoint(signal); ack(await adapter.reopenPropagation(), 'reopenPropagation'); checkpoint(signal); const identityPath = await writeEvidence(request.evidenceDirectory, 'checks/identity.json', propagation); evidencePaths.push(identityPath); checks.push({ id: 'identity', passed: true, evidencePath: identityPath });
      const hashes = new Map<string, string>(); for (const variant of ['1', '2', '3'] as const) { checkpoint(signal); ack(await adapter.setVariantVisibility(variant), 'setVariantVisibility'); checkpoint(signal); const visibility = await adapter.readVariantVisibility(); if (!visibility || visibility.visibleVariantIds.length !== 1 || visibility.visibleVariantIds[0] !== variant) throw new QualificationError('VARIANT_VISIBILITY_INVALID', `variant ${variant} visibility did not verify`); const result = await adapter.exporter({ variantId: variant, sentinelPath, evidenceDirectory: request.evidenceDirectory, workingTemplatePath: copy.path }); checkpoint(signal); if (!result || typeof result.path !== 'string') throw new QualificationError('EXPORT_EVIDENCE_INVALID', `variant ${variant} exporter did not return a file path`); const variantPath = isAbsolute(result.path) ? result.path : resolve(request.evidenceDirectory, result.path); if (!(await canonicalExistingInside(request.evidenceDirectory, variantPath))) throw new QualificationError('EXPORT_PATH_ESCAPE', `variant ${variant} path escaped evidence root or traversed a symlink`); const canonicalEvidenceRoot = await realpath(request.evidenceDirectory); const canonicalVariantPath = await realpath(variantPath); const relativePath = relative(canonicalEvidenceRoot, canonicalVariantPath).replaceAll('\\', '/'); const digest = await inspectExport(canonicalVariantPath, variant); if (hashes.has(digest)) throw new QualificationError('VARIANT_DUPLICATE', `variant ${variant} is identical to another variant`); hashes.set(digest, variant); const outputBytes = await readFile(canonicalVariantPath); const outputSha256 = createHash('sha256').update(outputBytes).digest('hex'); for (const target of selectors.targets) { const targetBaseline = baselineByTarget.get(target.targetCandidateId); if (!targetBaseline) throw new QualificationError('SENTINEL_BASELINE_INVALID', `variant ${variant} has no intended target region for ${target.targetCandidateId}`); const correspondence = await adapter.verifySentinelCorrespondence({ variantId: variant, sentinelPath, outputPath: canonicalVariantPath, baseline: targetBaseline }); if (!correspondence || correspondence.passed !== true || correspondence.targetId !== target.targetCandidateId || !same(correspondence.region, targetBaseline.region) || correspondence.baselinePath !== targetBaseline.path || correspondence.baselineBytes !== targetBaseline.bytes || correspondence.baselineSha256 !== targetBaseline.sha256 || correspondence.outputPath !== canonicalVariantPath || correspondence.outputBytes !== outputBytes.byteLength || correspondence.outputSha256 !== outputSha256 || !(await canonicalExistingInside(request.evidenceDirectory, correspondence.evidencePath))) throw new QualificationError('SENTINEL_CORRESPONDENCE_INVALID', `variant ${variant} source-to-output target correspondence was not independently verified for ${target.targetCandidateId}`); evidencePaths.push(correspondence.evidencePath); checks.push({ id: `sentinel-correspondence-${variant}-${target.targetCandidateId}`, passed: true, evidencePath: correspondence.evidencePath }); } evidencePaths.push(relativePath); checks.push({ id: `variant-${variant}`, passed: true, evidencePath: relativePath }); }
      const originalAfter = await hashFile(request.workingTemplatePath); const closureUnchanged = (await Promise.all(copy.closure.map(async (entry) => (await hashFile(entry.originalPath)) === entry.sha256))).every(Boolean); const originalsVerified = await copy.verifyOriginals(); if (!originalsVerified || !closureUnchanged || originalAfter !== originalMaster) throw new QualificationError('SOURCE_MUTATED', 'master or linked source verification failed'); const sourcePath = await writeEvidence(request.evidenceDirectory, 'checks/source-integrity.json', { master: { path: request.workingTemplatePath, before: originalMaster, after: originalAfter }, closure: copy.closure }); evidencePaths.push(sourcePath); checks.push({ id: 'source-integrity', passed: true, evidencePath: sourcePath });
      await clean(); const post = await adapter.snapshot('post'); evidencePaths.push(await writeEvidence(request.evidenceDirectory, 'snapshots/post.json', post)); checks.push({ id: 'cleanup', passed: true, evidencePath: 'snapshots/post.json' });
      for (const path of evidencePaths) if (pathEscape(path) || path.startsWith('/') || !(await canonicalExistingInside(request.evidenceDirectory, path))) throw new QualificationError('EVIDENCE_INCOMPLETE', `missing evidence ${path}`);
      const result = QualificationResultSchema.parse({ status: 'qualified', candidate: candidate(request, fileRef(copy.path, preparedSha, `${request.inspection.template.rootId}:qualification`), selectors, runtimeCapabilities), checks, evidencePaths, errors: [] }); return result;
    } catch (cause) {
      let barrierFailure: unknown;
      const ambiguous = !(cause instanceof QualificationError) || cause.category === 'ambiguousState' || cause.code.endsWith('_UNCERTAIN');
      if (ambiguous) {
        if (!adapter.lock.markUnknownMutation) barrierFailure = new QualificationError('RECOVERY_BARRIER_UNAVAILABLE', 'qualification barrier persistence is unavailable', 'ambiguousState');
        else try { await adapter.lock.markUnknownMutation(); } catch (error) { barrierFailure = new QualificationError('RECOVERY_BARRIER_PERSIST_FAILED', 'qualification barrier persistence failed', 'ambiguousState'); }
      }
      let cleanupFailure: unknown;
      if (!ambiguous) try { await clean(); } catch (error) { cleanupFailure = error; if (!adapter.lock.markUnknownMutation) barrierFailure ??= new QualificationError('RECOVERY_BARRIER_UNAVAILABLE', 'cleanup failure cannot retain the recovery barrier', 'ambiguousState'); else try { await adapter.lock.markUnknownMutation(); } catch { barrierFailure ??= new QualificationError('RECOVERY_BARRIER_PERSIST_FAILED', 'cleanup failure barrier persistence failed', 'ambiguousState'); } }
      // A persistence failure must escape the callback so the installation
      // lock cannot treat a returned blocked result as a completed operation.
      if (barrierFailure) throw barrierFailure;
      const primary = barrierFailure ?? cleanupFailure ?? cause; const source = primary && typeof primary === 'object' ? primary as Record<string, unknown> : {}; const failure = primary instanceof QualificationError ? primary : new QualificationError(typeof source.code === 'string' ? source.code : 'CLEANUP_FAILED', primary instanceof Error ? primary.message : typeof source.message === 'string' ? source.message : String(primary), (typeof source.category === 'string' && ['validation', 'capability', 'transient', 'ambiguousState', 'review', 'cancelled'].includes(source.category) ? source.category : 'ambiguousState') as DomainError['category'], typeof source.retryable === 'boolean' ? source.retryable : false, Array.isArray(source.evidencePaths) ? source.evidencePaths.filter((path): path is string => typeof path === 'string') : []); const existing = []; for (const path of evidencePaths) if (await canonicalExistingInside(request.evidenceDirectory, path)) existing.push(path); return blocked([domainError(failure.code, failure.message, failure.category, existing, failure)], checks.map((check) => ({ ...check, passed: false })), existing);
    }
  };
  try { return await adapter.lock.runExclusive(`qualification-${request.inspection.inspectionId}`, execute, signal); } catch (cause) {
    let barrierCode = 'QUALIFICATION_LOCK_FAILED';
    let barrierMessage = cause instanceof Error ? cause.message : String(cause);
    if (adapter.lock.markUnknownMutation) {
      try { await adapter.lock.markUnknownMutation(); } catch { barrierCode = 'RECOVERY_BARRIER_PERSIST_FAILED'; barrierMessage = 'qualification barrier persistence failed'; }
    } else { barrierCode = 'RECOVERY_BARRIER_UNAVAILABLE'; barrierMessage = 'qualification barrier persistence is unavailable'; }
    return blocked([domainError(barrierCode, barrierMessage, 'ambiguousState')], [], []);
  }
}

export const qualifyTemplate = qualify;
