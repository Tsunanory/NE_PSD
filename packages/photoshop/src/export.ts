import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import sharp, { type Metadata } from 'sharp';
import { VariantArtifactSchema, type OutputSpec, type VariantArtifact } from '@ne-psd/contracts';

export type ExportVariantId = '1' | '2' | '3';
export const EXPORT_VARIANT_IDS: readonly ExportVariantId[] = ['1', '2', '3'];

export type ExportErrorCode =
  | 'EXPORT_CAPABILITY_MISSING' | 'EXPORT_POLICY_INVALID' | 'MUTATION_UNACKNOWLEDGED'
  | 'VISIBILITY_INVALID' | 'EXPORT_UNACKNOWLEDGED' | 'EXPORT_PATH_INVALID'
  | 'EXPORT_PATH_MISMATCH' | 'OUTPUT_EXISTS' | 'FILE_INVALID' | 'QUALITY_UNIT_MISMATCH'
  | 'DISPOSABLE_CLEANUP_UNACKNOWLEDGED' | 'BUNDLE_ROOT_INVALID';

export class ExportError extends Error {
  readonly name = 'ExportError';
  constructor(readonly code: ExportErrorCode, message: string, readonly evidence: Readonly<Record<string, unknown>> = {}) { super(`${code}: ${message}`); }
}

export type VisibilityRead = {
  acknowledged: true;
  ancestorVisible: boolean;
  visibleVariantIds: readonly string[];
};

export type ExportPreparation = {
  acknowledged: true;
  disposable: true;
  documentId: string;
  convertedPixels: true;
  renderingIntent: 'relative-colorimetric' | 'perceptual' | 'absolute-colorimetric' | 'saturation';
  mode: 'RGB';
  bitDepth: 8;
  embeddedProfile: 'sRGB';
  flattened: boolean;
  alpha: 'preserve' | 'opaque';
};

export type ExportAdapter = {
  restoreQualifiedState: () => Promise<unknown>;
  hideVariant: (variantId: ExportVariantId) => Promise<unknown>;
  showVariant: (variantId: ExportVariantId) => Promise<unknown>;
  readVisibility: () => Promise<unknown>;
  prepareExport: (input: { output: OutputSpec; alphaPolicy: AlphaPolicy; background?: Rgb }) => Promise<unknown>;
  exportVariant: (input: { variantId: ExportVariantId; destination: string; format: 'jpeg' | 'png'; quality?: number; colorSpace: 'sRGB'; background?: Rgb }) => Promise<unknown>;
  cleanupDisposable: (documentId: string) => Promise<unknown>;
};

export type Rgb = { r: number; g: number; b: number };
export type AlphaPolicy = 'preserve' | 'opaque';
export type QualityEvidence = { unit: '1-100' | '0-12' };
export type ExportOptions = {
  bundleRoot: string;
  approvedBundleRoot: string;
  output: OutputSpec;
  adapter: ExportAdapter;
  alphaPolicy: AlphaPolicy;
  jpegBackground?: Rgb;
  renderingIntent: ExportPreparation['renderingIntent'];
  qualityEvidence?: QualityEvidence;
  signal?: AbortSignal;
};
export type VisibilityEvidence = { variantId: ExportVariantId; visibleVariantIds: ExportVariantId[]; evidencePath: string };
export type ExportResult = {
  artifacts: [VariantArtifact, VariantArtifact, VariantArtifact];
  visibility: [VisibilityEvidence, VisibilityEvidence, VisibilityEvidence];
  cleanup: { acknowledged: true; documentId: string };
};

const acknowledged = (value: unknown): value is { acknowledged: true } => value !== null && typeof value === 'object' && (value as { acknowledged?: unknown }).acknowledged === true;
const checkpoint = (signal?: AbortSignal): void => { if (signal?.aborted) throw new ExportError('EXPORT_POLICY_INVALID', 'export cancelled before a safe boundary'); };

export function mapExportQuality(quality: number, evidence: QualityEvidence): number {
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) throw new ExportError('QUALITY_UNIT_MISMATCH', 'quality must satisfy the shared 1..100 contract');
  if (evidence.unit !== '1-100') throw new ExportError('QUALITY_UNIT_MISMATCH', 'backend quality units are not qualified as 1..100');
  return quality;
}

function within(root: string, target: string): boolean {
  const value = relative(root, target);
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value));
}

async function assertNoSymlink(root: string, target: string): Promise<void> {
  const rootResolved = resolve(root);
  const targetResolved = resolve(target);
  if (!within(rootResolved, targetResolved)) throw new ExportError('EXPORT_PATH_INVALID', 'export path escapes the attempt bundle');
  const parts = relative(rootResolved, targetResolved).split(/[\\/]/).filter(Boolean);
  let current = rootResolved;
  for (const part of parts) {
    current = resolve(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new ExportError('EXPORT_PATH_INVALID', 'export path traverses a symlink');
    } catch (error) {
      if (error instanceof ExportError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

async function safeOutputPath(root: string, variantId: ExportVariantId, format: 'jpeg' | 'png'): Promise<string> {
  const variantsRoot = resolve(root, 'variants');
  await mkdir(variantsRoot, { recursive: true });
  await assertNoSymlink(root, variantsRoot);
  const destination = resolve(variantsRoot, `${variantId}.${format}`);
  await assertNoSymlink(root, destination);
  try { if ((await lstat(destination)).isSymbolicLink() || (await lstat(destination)).isFile()) throw new ExportError('OUTPUT_EXISTS', `output already exists: ${destination}`); }
  catch (error) { if (error instanceof ExportError) throw error; if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return destination;
}

function relativePath(root: string, path: string): string {
  const value = relative(resolve(root), resolve(path)).replaceAll('\\', '/');
  if (!value || value.startsWith('../') || value === '..' || value.startsWith('/')) throw new ExportError('EXPORT_PATH_INVALID', 'artifact path is not relative to the attempt bundle');
  return value;
}

function isSrgb(metadata: Metadata): boolean {
  const icc = metadata.icc;
  // Sharp reports the decoded ICC color space as `srgb`; requiring an actual
  // profile rejects untagged files while avoiding a brittle ICC-description scan.
  return metadata.hasProfile === true && metadata.space === 'srgb' && Boolean(icc);
}

function closeTo(actual: number, expected: number, tolerance = 18): boolean { return Math.abs(actual - expected) <= tolerance; }

async function inspectFile(path: string, output: OutputSpec, alphaPolicy: AlphaPolicy, jpegBackground?: Rgb): Promise<{ bytes: number; width: number; height: number; format: 'jpeg' | 'png' }> {
  let metadata: Metadata;
  try { metadata = await sharp(path, { failOn: 'error' }).metadata(); } catch (error) { throw new ExportError('FILE_INVALID', `unable to decode exported file: ${error instanceof Error ? error.message : 'decode failed'}`); }
  const format = metadata.format as string;
  if (format !== output.format || metadata.width !== output.width || metadata.height !== output.height || !isSrgb(metadata)) throw new ExportError('FILE_INVALID', 'format, dimensions or embedded sRGB profile do not match the policy');
  if (output.format === 'png' && alphaPolicy === 'preserve' && metadata.hasAlpha !== true) throw new ExportError('FILE_INVALID', 'PNG export did not preserve alpha');
  if (output.format === 'jpeg' && (metadata.hasAlpha === true || (metadata.channels ?? 0) !== 3)) throw new ExportError('FILE_INVALID', 'JPEG export has unintended alpha');
  try {
    const decoded = await sharp(path, { failOn: 'error' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (decoded.info.width !== output.width || decoded.info.height !== output.height || decoded.data.byteLength === 0) throw new Error('pixel decode mismatch');
    if (output.format === 'png' && alphaPolicy === 'opaque' && Array.from(decoded.data).some((value, index) => index % 4 === 3 && value !== 255)) throw new Error('PNG output contains transparency under opaque policy');
    if (output.format === 'jpeg' && jpegBackground) {
      const points = [[0, 0], [decoded.info.width - 1, 0], [0, decoded.info.height - 1], [decoded.info.width - 1, decoded.info.height - 1]] as const;
      for (const [x, y] of points) {
        const offset = (y * decoded.info.width + x) * 4;
        if (!closeTo(decoded.data[offset]!, jpegBackground.r) || !closeTo(decoded.data[offset + 1]!, jpegBackground.g) || !closeTo(decoded.data[offset + 2]!, jpegBackground.b)) throw new Error('JPEG matte does not match decoded background pixels');
      }
    }
  } catch (error) { if (error instanceof ExportError) throw error; throw new ExportError('FILE_INVALID', `export has unreadable pixels: ${error instanceof Error ? error.message : 'decode failed'}`); }
  const bytes = (await lstat(path)).size;
  if (!Number.isInteger(bytes) || bytes <= 0) throw new ExportError('FILE_INVALID', 'export is empty');
  return { bytes, width: output.width, height: output.height, format: output.format };
}

function validatePolicy(options: ExportOptions): void {
  const { output, alphaPolicy } = options;
  if (!Number.isInteger(output.quality) || output.quality < 1 || output.quality > 100) throw new ExportError('QUALITY_UNIT_MISMATCH', 'quality must satisfy the shared 1..100 contract');
  if (output.colorSpace !== 'sRGB') throw new ExportError('EXPORT_POLICY_INVALID', 'only sRGB output is supported');
  if (output.format === 'jpeg' && (alphaPolicy !== 'opaque' || !options.jpegBackground || ![options.jpegBackground.r, options.jpegBackground.g, options.jpegBackground.b].every((n) => Number.isInteger(n) && n >= 0 && n <= 255))) throw new ExportError('EXPORT_POLICY_INVALID', 'JPEG requires an explicit opaque background policy');
  if (output.format === 'png' && alphaPolicy !== 'preserve' && alphaPolicy !== 'opaque') throw new ExportError('EXPORT_POLICY_INVALID', 'PNG alpha policy is not qualified');
  if (output.format === 'jpeg' && !options.qualityEvidence) throw new ExportError('QUALITY_UNIT_MISMATCH', 'JPEG quality-unit evidence is missing');
  if (!options.renderingIntent) throw new ExportError('EXPORT_POLICY_INVALID', 'rendering intent policy is missing');
}

async function validateBundleRoot(options: ExportOptions): Promise<void> {
  if (!isAbsolute(options.bundleRoot) || !isAbsolute(options.approvedBundleRoot)) throw new ExportError('BUNDLE_ROOT_INVALID', 'bundle roots must be absolute canonical paths');
  let actual: string;
  let approved: string;
  try {
    const [actualStat, approvedStat] = await Promise.all([lstat(options.bundleRoot), lstat(options.approvedBundleRoot)]);
    if (actualStat.isSymbolicLink() || approvedStat.isSymbolicLink()) throw new ExportError('BUNDLE_ROOT_INVALID', 'bundle roots may not be symlinks');
    [actual, approved] = await Promise.all([realpath(options.bundleRoot), realpath(options.approvedBundleRoot)]);
  } catch (error) {
    if (error instanceof ExportError) throw error;
    throw new ExportError('BUNDLE_ROOT_INVALID', `bundle root is not an existing canonical directory: ${error instanceof Error ? error.message : 'unavailable'}`);
  }
  if (actual !== approved) throw new ExportError('BUNDLE_ROOT_INVALID', 'bundle root is outside the approved canonical job bundle root');
}

async function visibility(options: ExportOptions, variantId: ExportVariantId, evidencePath: string): Promise<VisibilityEvidence> {
  checkpoint(options.signal);
  for (const id of EXPORT_VARIANT_IDS) {
    const response = await options.adapter.hideVariant(id);
    if (!acknowledged(response)) throw new ExportError('MUTATION_UNACKNOWLEDGED', `hide ${id} was not acknowledged`);
  }
  const shown = await options.adapter.showVariant(variantId);
  if (!acknowledged(shown)) throw new ExportError('MUTATION_UNACKNOWLEDGED', `show ${variantId} was not acknowledged`);
  const response = await options.adapter.readVisibility();
  if (!response || typeof response !== 'object' || (response as { acknowledged?: unknown }).acknowledged !== true) throw new ExportError('VISIBILITY_INVALID', 'visibility reread was not acknowledged');
  const read = response as VisibilityRead;
  const visible = [...read.visibleVariantIds];
  if (read.ancestorVisible !== true || visible.length !== 1 || visible[0] !== variantId || visible.some((id) => !EXPORT_VARIANT_IDS.includes(id as ExportVariantId))) throw new ExportError('VISIBILITY_INVALID', `effective visibility is not exactly [${variantId}]`, { visible, ancestorVisible: read.ancestorVisible });
  return { variantId, visibleVariantIds: [variantId], evidencePath };
}

export async function exportVariants(options: ExportOptions): Promise<ExportResult> {
  validatePolicy(options);
  await validateBundleRoot(options);
  const artifacts: VariantArtifact[] = [];
  const visibilityEvidence: VisibilityEvidence[] = [];
  let cleanupResult: { acknowledged: true; documentId: string } | undefined;
  let preparedDocumentId: string | undefined;
  try {
    const preparation = await options.adapter.prepareExport({ output: options.output, alphaPolicy: options.alphaPolicy, ...(options.jpegBackground ? { background: options.jpegBackground } : {}) });
    if (preparation && typeof preparation === 'object' && typeof (preparation as { documentId?: unknown }).documentId === 'string') preparedDocumentId = (preparation as { documentId: string }).documentId;
    if (!preparation || typeof preparation !== 'object' || (preparation as { acknowledged?: unknown }).acknowledged !== true) throw new ExportError('MUTATION_UNACKNOWLEDGED', 'export preparation was not acknowledged');
    const prepared = preparation as ExportPreparation;
    if (prepared.disposable !== true || prepared.convertedPixels !== true || prepared.mode !== 'RGB' || prepared.bitDepth !== 8 || prepared.embeddedProfile !== 'sRGB' || prepared.renderingIntent !== options.renderingIntent || (options.output.format === 'jpeg' && (prepared.flattened !== true || prepared.alpha !== 'opaque')) || (options.output.format === 'png' && prepared.alpha !== options.alphaPolicy)) throw new ExportError('EXPORT_POLICY_INVALID', 'export preparation does not prove the qualified color/alpha/intent policy');
    for (const variantId of EXPORT_VARIANT_IDS) {
      checkpoint(options.signal);
      const restored = await options.adapter.restoreQualifiedState();
      if (!acknowledged(restored)) throw new ExportError('MUTATION_UNACKNOWLEDGED', 'qualified common/ancestor state was not restored');
      const destination = await safeOutputPath(options.bundleRoot, variantId, options.output.format);
      const evidenceRel = `visibility/${variantId}.json`;
      const evidenceAbs = resolve(options.bundleRoot, evidenceRel);
      await mkdir(resolve(evidenceAbs, '..'), { recursive: true });
      const evidence = await visibility(options, variantId, evidenceRel);
      await writeFile(evidenceAbs, JSON.stringify(evidence));
      visibilityEvidence.push(evidence);
      const quality = options.output.format === 'jpeg' ? mapExportQuality(options.output.quality, options.qualityEvidence!) : undefined;
      const exported = await options.adapter.exportVariant({ variantId, destination, format: options.output.format, ...(quality === undefined ? {} : { quality }), colorSpace: 'sRGB', ...(options.jpegBackground ? { background: options.jpegBackground } : {}) });
      if (!exported || typeof exported !== 'object' || (exported as { acknowledged?: unknown }).acknowledged !== true) throw new ExportError('EXPORT_UNACKNOWLEDGED', `export ${variantId} was not acknowledged`);
      const reported = (exported as { path?: unknown }).path;
      if (typeof reported !== 'string' || resolve(options.bundleRoot, reported) !== destination) throw new ExportError('EXPORT_PATH_MISMATCH', `export ${variantId} returned a mismatched path`);
      await assertNoSymlink(options.bundleRoot, destination);
      const decoded = await inspectFile(destination, options.output, options.alphaPolicy, options.jpegBackground);
      const bytes = await readFile(destination);
      const artifact: VariantArtifact = VariantArtifactSchema.parse({ variantId, path: relativePath(options.bundleRoot, destination), sha256: createHash('sha256').update(bytes).digest('hex'), bytes: decoded.bytes, width: decoded.width, height: decoded.height, format: decoded.format, colorSpace: 'sRGB' });
      artifacts.push(artifact);
    }
  } finally {
    if (preparedDocumentId) {
      const cleanup = await options.adapter.cleanupDisposable(preparedDocumentId);
      if (!acknowledged(cleanup)) throw new ExportError('DISPOSABLE_CLEANUP_UNACKNOWLEDGED', 'disposable export document cleanup was not acknowledged');
      cleanupResult = { acknowledged: true, documentId: preparedDocumentId };
    }
  }
  if (artifacts.length !== 3 || visibilityEvidence.length !== 3 || !cleanupResult) throw new ExportError('FILE_INVALID', 'three verified artifacts were not produced');
  return { artifacts: artifacts as [VariantArtifact, VariantArtifact, VariantArtifact], visibility: visibilityEvidence as [VisibilityEvidence, VisibilityEvidence, VisibilityEvidence], cleanup: cleanupResult };
}
