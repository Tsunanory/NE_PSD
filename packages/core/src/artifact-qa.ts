import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import sharp from 'sharp';
import { RenderEvidenceSchema, RenderRequestSchema, RenderEvidenceV2Schema, RenderRequestV2Schema, RelativePathSchema, type Rect, type RenderEvidence, type RenderRequest, type RenderEvidenceV2, type RenderRequestV2, type VariantId } from '@ne-psd/contracts';

export type ArtifactQaInput = {
  request: RenderRequest | RenderRequestV2;
  evidence: RenderEvidence | RenderEvidenceV2;
  expectedReviewPolicySha256: string;
  sourceRelativePath: string;
  evidenceInputDigests: Record<string, string>;
  exportsRelativeDirectory: string;
  fitTolerance: { qualificationId: string; profileSha256: string; pixels: number };
  qualityCalibration?: {
    qualificationId: string;
    profileSha256: string;
    maxFirstPixelMatchFraction: number;
    minOpaquePixelFraction: number;
    maxIdenticalPairCount: number;
  };
};

export type ArtifactQaRequirement = 'BINDING.CURRENT_ATTEMPT' | 'ARTIFACTS.EXACTLY_THREE' | 'IMAGE.DECODE_FORMAT'
  | 'IMAGE.DIMENSIONS_COLOR' | 'GEOMETRY.REQUESTED_FIT' | 'CLIPPING.ALPHA_ADJACENCY'
  | 'VARIANTS.VISIBILITY' | 'EVIDENCE.TRACE_COMPLETE' | 'IMAGE.QUALITY';

export type ArtifactQaResult = {
  artifactChecksPassed: true;
  requirementResults: Record<ArtifactQaRequirement, 'pass' | 'unknown'>;
  artifacts: Array<{ variantId: VariantId; path: string; sha256: string; bytes: number; pixelSha256: string; pixelBytes: number; width: number; height: number; format: 'jpeg' | 'png'; hasAlpha: boolean; firstPixelMatchFraction: number; opaquePixelFraction: number }>;
  diagnostics: string[];
  bindings: { jobId: string; assetId: string; attempt: 1 | 2; profileSha256: string; sourceSha256: string; toolSchemaSha256: string; reviewPolicySha256: string };
};

export class ArtifactQaError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ArtifactQaError'; }
}

const fail = (code: string, message: string): never => { throw new ArtifactQaError(code, message); };
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const sha256 = /^[a-f0-9]{64}$/;
const ids = ['1', '2', '3'] as const;
const dimensions = (rect: Rect) => ({ width: rect.right - rect.left, height: rect.bottom - rect.top });
const near = (actual: number, expected: number, tolerance: number) => Math.abs(actual - expected) <= tolerance;

function safeRelative(path: string): string {
  if (!RelativePathSchema.safeParse(path).success) fail('SCHEMA_INVALID', `invalid relative path: ${path}`);
  return path;
}

async function canonicalRoot(requested: string): Promise<string> {
  if (!isAbsolute(requested)) fail('PATH_UNSAFE', 'staging root must be absolute');
  const info = await lstat(requested).catch(() => fail('PATH_UNSAFE', 'staging root is missing'));
  if (!info.isDirectory() || info.isSymbolicLink()) fail('PATH_UNSAFE', 'staging root must be a real directory');
  return realpath(requested);
}

async function confinedPath(root: string, relativePath: string, kind: 'file' | 'directory'): Promise<string> {
  const path = safeRelative(relativePath);
  let current = root;
  for (const segment of path.split('/')) {
    current = join(current, segment);
    const info = await lstat(current).catch(() => fail('PATH_UNSAFE', `missing path: ${path}`));
    if (info.isSymbolicLink()) fail('PATH_UNSAFE', `symlink in path: ${path}`);
  }
  const resolvedPath = await realpath(current).catch(() => fail('PATH_UNSAFE', `unresolvable path: ${path}`));
  const fromRoot = relative(root, resolvedPath);
  if (fromRoot === '..' || fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(fromRoot)) fail('PATH_UNSAFE', `path escapes staging root: ${path}`);
  const info = await lstat(current);
  if (kind === 'file' && !info.isFile()) fail('PATH_UNSAFE', `not a regular file: ${path}`);
  if (kind === 'directory' && !info.isDirectory()) fail('PATH_UNSAFE', `not a directory: ${path}`);
  return resolvedPath;
}

async function readConfined(root: string, path: string): Promise<Buffer> {
  const resolvedPath = await confinedPath(root, path, 'file');
  return readFile(resolvedPath);
}

async function exportFiles(root: string, directory: string): Promise<string[]> {
  const absolute = await confinedPath(root, directory, 'directory');
  const found: string[] = [];
  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isSymbolicLink()) fail('PATH_UNSAFE', `symlink in exports: ${path}`);
    if (entry.isDirectory()) found.push(...await exportFiles(root, path));
    else if (entry.isFile()) found.push(path);
    else fail('PATH_UNSAFE', `special file in exports: ${path}`);
  }
  return found;
}

async function decode(bytes: Buffer, label: string) {
  try {
    const image = sharp(bytes, { failOn: 'error' });
    const metadata = await image.metadata();
    const decoded = await sharp(bytes, { failOn: 'error' }).raw().toBuffer({ resolveWithObject: true });
    if (!metadata.width || !metadata.height || decoded.data.length === 0) fail('IMAGE_DECODE_FAILED', `no pixels: ${label}`);
    return { metadata, decoded };
  } catch (error) {
    if (error instanceof ArtifactQaError) throw error;
    return fail('IMAGE_DECODE_FAILED', `cannot fully decode ${label}`);
  }
}

function checkGeometry(input: ArtifactQaInput, sourceWidth: number, sourceHeight: number): void {
  const { profile } = input.request;
  const { geometry } = input.evidence;
  const tolerance = input.fitTolerance.pixels;
  if (input.fitTolerance.qualificationId !== profile.qualificationId || input.fitTolerance.profileSha256 !== profile.profileSha256
    || !Number.isFinite(tolerance) || tolerance < 0 || tolerance > 4) fail('GEOMETRY_MISMATCH', 'fit tolerance is not qualified for this profile');
  if (geometry.length !== profile.targets.length) fail('GEOMETRY_MISMATCH', 'geometry target count differs from profile');
  const targets = new Set<string>();
  for (const item of geometry) {
    const key = JSON.stringify(item.target);
    if (targets.has(key) || !profile.targets.some((target) => JSON.stringify(target.target) === key)) fail('GEOMETRY_MISMATCH', 'unexpected or duplicate geometry target');
    targets.add(key);
    if (item.fitMode !== profile.fitMode || !item.clipped || !item.adjacentToReference) fail('GEOMETRY_MISMATCH', 'fit, clipping, or adjacency evidence differs from profile');
    const reference = dimensions(item.reference);
    const placed = dimensions(item.placed);
    const scale = profile.fitMode === 'cover'
      ? Math.max(reference.width / sourceWidth, reference.height / sourceHeight)
      : Math.min(reference.width / sourceWidth, reference.height / sourceHeight);
    const expectedWidth = profile.fitMode === 'stretch' ? reference.width : sourceWidth * scale;
    const expectedHeight = profile.fitMode === 'stretch' ? reference.height : sourceHeight * scale;
    if (!near(placed.width, expectedWidth, tolerance) || !near(placed.height, expectedHeight, tolerance)
      || !near((item.placed.left + item.placed.right) / 2, (item.reference.left + item.reference.right) / 2, tolerance)
      || !near((item.placed.top + item.placed.bottom) / 2, (item.reference.top + item.reference.bottom) / 2, tolerance)) fail('GEOMETRY_MISMATCH', 'placed bounds differ from requested fit');
  }
}

function checkVisibility(evidence: RenderEvidence | RenderEvidenceV2): void {
  if (evidence.visibility.length !== 3) fail('VISIBILITY_MISMATCH', 'expected one visibility record per variant');
  for (const id of ids) {
    const matching = evidence.visibility.filter((item) => item.variantId === id);
    if (matching.length !== 1 || matching[0]!.visibleVariantIds.length !== 1 || matching[0]!.visibleVariantIds[0] !== id) fail('VISIBILITY_MISMATCH', `variant ${id} is not uniquely visible`);
  }
}

export async function verifyArtifactQa(input: ArtifactQaInput): Promise<ArtifactQaResult> {
  const v2 = input.request.schemaVersion === 2;
  if (v2
    ? !RenderRequestV2Schema.safeParse(input.request).success || !RenderEvidenceV2Schema.safeParse(input.evidence).success
    : !RenderRequestSchema.safeParse(input.request).success || !RenderEvidenceSchema.safeParse(input.evidence).success) fail('SCHEMA_INVALID', 'render request or evidence is malformed');
  const { request, evidence } = input;
  if (request.schemaVersion === 2 && (evidence.schemaVersion !== 2 || evidence.operationId !== request.operationId)) fail('BINDING_MISMATCH', 'V2 operation identity differs from request');
  if (!sha256.test(input.expectedReviewPolicySha256)
    || evidence.jobId !== request.jobId || evidence.assetId !== request.asset.assetId || evidence.attempt !== request.attempt
    || evidence.profileSha256 !== request.profile.profileSha256 || evidence.sourceSha256 !== request.asset.source.sha256
    || evidence.toolSchemaSha256 !== request.profile.toolSchemaSha256) fail('BINDING_MISMATCH', 'render evidence does not match trusted request/policy bindings');
  const calibration = input.qualityCalibration;
  if (calibration && (calibration.qualificationId !== request.profile.qualificationId
    || calibration.profileSha256 !== request.profile.profileSha256
    || !Number.isFinite(calibration.maxFirstPixelMatchFraction) || calibration.maxFirstPixelMatchFraction < 0 || calibration.maxFirstPixelMatchFraction > 1
    || !Number.isFinite(calibration.minOpaquePixelFraction) || calibration.minOpaquePixelFraction < 0 || calibration.minOpaquePixelFraction > 1
    || !Number.isInteger(calibration.maxIdenticalPairCount) || calibration.maxIdenticalPairCount < 0 || calibration.maxIdenticalPairCount > 3)) fail('IMAGE_QUALITY_UNQUALIFIED', 'quality limits are not bounded to this qualified profile');
  const root = await canonicalRoot(request.stagingDirectory);
  const exportsDirectory = safeRelative(input.exportsRelativeDirectory);
  const paths = evidence.artifacts.map((item) => safeRelative(item.path));
  if (new Set(paths.map((path) => path.toLowerCase())).size !== 3 || paths.some((path) => !path.startsWith(`${exportsDirectory}/`))) fail('ARTIFACT_SET_INVALID', 'artifact paths must be three distinct files inside the export directory');
  const present = await exportFiles(root, exportsDirectory);
  if (present.length !== 3 || present.some((path) => !paths.includes(path))) fail('ARTIFACT_SET_INVALID', 'export directory differs from declared three-file set');

  const sourcePath = safeRelative(input.sourceRelativePath);
  if (request.schemaVersion === 2 && sourcePath !== request.ownedInput.source.relativePath) fail('BINDING_MISMATCH', 'V2 QA source must be the exact opened owned copy');
  const requiredInputs = new Set([sourcePath, evidence.documentTracePath, evidence.toolTracePath, ...evidence.checks.map((check) => check.evidencePath)]);
  if (request.schemaVersion === 2 && evidence.schemaVersion === 2) {
    for (const ref of [request.ownedInput.closureProof, evidence.ownedInputProof, evidence.templateClosureProof, evidence.releaseProof]) {
      requiredInputs.add(ref.relativePath);
      if (input.evidenceInputDigests[ref.relativePath] !== ref.sha256) fail('EVIDENCE_INPUT_MISMATCH', `V2 proof digest differs: ${ref.relativePath}`);
    }
  }
  if (evidence.checks.length === 0 || new Set(evidence.checks.map((check) => check.id)).size !== evidence.checks.length || evidence.checks.some((check) => !check.passed)) fail('EVIDENCE_INPUT_MISMATCH', 'producer check evidence is missing, duplicate, or reports failure');
  if (input.evidenceInputDigests[sourcePath] !== request.asset.source.sha256) fail('EVIDENCE_INPUT_MISMATCH', 'trusted source digest differs from requested source');
  for (const path of requiredInputs) if (!input.evidenceInputDigests[path]) fail('EVIDENCE_INPUT_MISMATCH', `missing expected digest for ${path}`);
  for (const [path, expected] of Object.entries(input.evidenceInputDigests)) {
    safeRelative(path);
    if (!sha256.test(expected) || hash(await readConfined(root, path)) !== expected) fail('EVIDENCE_INPUT_MISMATCH', `evidence input changed: ${path}`);
  }
  const sourceBytes = await readConfined(root, sourcePath);
  if (sourceBytes.length !== request.asset.sourceBytes) fail('EVIDENCE_INPUT_MISMATCH', 'source byte count differs from request');
  const source = await decode(sourceBytes, sourcePath);
  checkGeometry(input, source.metadata.width!, source.metadata.height!);
  checkVisibility(evidence);

  const artifacts: ArtifactQaResult['artifacts'] = [];
  const diagnostics: string[] = [];
  for (const id of ids) {
    const artifact = evidence.artifacts.find((item) => item.variantId === id)!;
    const bytes = await readConfined(root, artifact.path);
    if (bytes.length !== artifact.bytes || hash(bytes) !== artifact.sha256) fail('ARTIFACT_DIGEST_MISMATCH', `artifact ${id} bytes differ from evidence`);
    const { metadata, decoded } = await decode(bytes, artifact.path);
    const output = request.profile.output;
    if (metadata.format !== output.format || artifact.format !== output.format
      || metadata.width !== output.width || artifact.width !== output.width
      || metadata.height !== output.height || artifact.height !== output.height
      || metadata.space !== 'srgb' || artifact.colorSpace !== output.colorSpace
      || (output.format === 'jpeg' && metadata.hasAlpha)) fail('IMAGE_SPEC_MISMATCH', `artifact ${id} actual image differs from requested output`);
    const channels = decoded.info.channels;
    let matchingFirstPixel = 0;
    let opaquePixels = 0;
    const pixelCount = decoded.data.length / channels;
    for (let offset = 0; offset < decoded.data.length; offset += channels) {
      let matches = true;
      for (let channel = 0; channel < channels; channel++) if (decoded.data[offset + channel] !== decoded.data[channel]) { matches = false; break; }
      if (matches) matchingFirstPixel++;
      if (!metadata.hasAlpha || decoded.data[offset + channels - 1] === 255) opaquePixels++;
    }
    const firstPixelMatchFraction = matchingFirstPixel / pixelCount;
    const opaquePixelFraction = opaquePixels / pixelCount;
    if (firstPixelMatchFraction === 1) diagnostics.push(`UNIFORM_PIXELS:${id}`);
    artifacts.push({ variantId: id, path: artifact.path, sha256: artifact.sha256, bytes: bytes.length,
      pixelSha256: hash(decoded.data), pixelBytes: decoded.data.length, width: metadata.width!, height: metadata.height!,
      format: output.format, hasAlpha: Boolean(metadata.hasAlpha), firstPixelMatchFraction, opaquePixelFraction });
  }
  if (new Set(artifacts.map((item) => item.sha256)).size < 3) diagnostics.push('DUPLICATE_EXPORT_BYTES');
  const identicalPairCount = artifacts.reduce((total, current, index) => total + artifacts.slice(index + 1).filter((other) => other.pixelSha256 === current.pixelSha256).length, 0);
  if (calibration && (artifacts.some((item) => item.firstPixelMatchFraction > calibration.maxFirstPixelMatchFraction
    || item.opaquePixelFraction < calibration.minOpaquePixelFraction)
    || identicalPairCount > calibration.maxIdenticalPairCount)) fail('IMAGE_QUALITY_FAILED', 'measured pixels fail the profile-specific quality limits');
  return { artifactChecksPassed: true, requirementResults: {
    'BINDING.CURRENT_ATTEMPT': 'unknown', 'ARTIFACTS.EXACTLY_THREE': 'pass', 'IMAGE.DECODE_FORMAT': 'pass',
    'IMAGE.DIMENSIONS_COLOR': 'pass', 'GEOMETRY.REQUESTED_FIT': 'unknown', 'CLIPPING.ALPHA_ADJACENCY': 'unknown',
    'VARIANTS.VISIBILITY': 'unknown', 'EVIDENCE.TRACE_COMPLETE': 'unknown', 'IMAGE.QUALITY': calibration ? 'pass' : 'unknown',
  }, artifacts, diagnostics,
    bindings: { jobId: request.jobId, assetId: request.asset.assetId, attempt: request.attempt,
      profileSha256: request.profile.profileSha256, sourceSha256: request.asset.source.sha256,
      toolSchemaSha256: request.profile.toolSchemaSha256, reviewPolicySha256: input.expectedReviewPolicySha256 } };
}
