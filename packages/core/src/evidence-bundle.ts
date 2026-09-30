import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import sharp from 'sharp';
import {
  bundleDigest, canonicalize, EvidenceBundleManifestSchema, RenderEvidenceSchema, RenderRequestSchema,
  RenderEvidenceV2Schema, RenderRequestV2Schema, OwnedInputProofV2Schema, TemplateClosureProofV2Schema, ReleaseProofV2Schema,
  validateTemplateClosureProofV2, validateReleaseProofV2,
  type EvidenceBundleManifest, type ManifestFile, type Rect, type ReviewEvidence, type RenderRequest, type RenderRequestV2, type VariantId, type VisionInput,
} from '@ne-psd/contracts';

export type ReferenceInput = { variantId: VariantId; path: string; sha256: string; qualificationId: string };
export type DetailInput = { variantId: VariantId; path: string; derivedFromPath: string; crop: Rect };
export type EvidenceBundleInput = {
  root: string;
  request: RenderRequest | RenderRequestV2;
  evidence: ReviewEvidence;
  sourcePath: string;
  references: readonly ReferenceInput[];
  details: readonly DetailInput[];
};

const ids = ['1', '2', '3'] as const;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const fail = (reason: string): never => { throw new Error(`EVIDENCE_BUNDLE_INVALID: ${reason}`); };
const portableKey = (path: string) => path.normalize('NFKC').toLocaleLowerCase('en-US');

function checkPath(path: string): void {
  if (!path || path !== path.normalize('NFC') || isAbsolute(path) || win32.isAbsolute(path) || path.includes('\\') || path.includes('\0')) fail(`unsafe path: ${path}`);
  for (const part of path.split('/')) {
    if (!part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/u.test(part) || /[. ]$/u.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)) fail(`unsafe path: ${path}`);
  }
}

async function rootPath(root: string): Promise<string> {
  if (!isAbsolute(root)) fail('root must be absolute');
  const info = await lstat(root).catch(() => fail('root missing'));
  if (!info.isDirectory() || info.isSymbolicLink()) fail('root is not a real directory');
  return realpath(root);
}

async function readBound(root: string, path: string): Promise<Buffer> {
  checkPath(path);
  const candidate = resolve(root, path);
  const fromRoot = relative(root, candidate);
  if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) fail(`path escapes root: ${path}`);
  let current = candidate;
  while (current !== root) {
    const info = await lstat(current).catch(() => fail(`missing file: ${path}`));
    if (info.isSymbolicLink()) fail(`symlink in path: ${path}`);
    current = dirname(current);
  }
  const physical = await realpath(candidate);
  if (physical !== candidate || (await realpath(root)) !== root) fail(`path changed: ${path}`);
  const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size <= 0) fail(`not a nonempty file: ${path}`);
    const bytes = Buffer.alloc(before.size);
    let position = 0;
    while (position < bytes.length) {
      const read = await handle.read(bytes, position, bytes.length - position, position);
      if (read.bytesRead <= 0) fail(`file shortened: ${path}`);
      position += read.bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== before.size || after.dev !== before.dev || after.ino !== before.ino
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || (await realpath(candidate)) !== candidate) fail(`file changed during read: ${path}`);
    return bytes;
  } finally { await handle.close(); }
}

async function hashBound(root: string, path: string): Promise<{ sha256: string; bytes: number }> {
  checkPath(path);
  const candidate = resolve(root, path);
  const fromRoot = relative(root, candidate);
  if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) fail(`path escapes root: ${path}`);
  let current = candidate;
  while (current !== root) {
    const info = await lstat(current).catch(() => fail(`missing file: ${path}`));
    if (info.isSymbolicLink()) fail(`symlink in path: ${path}`);
    current = dirname(current);
  }
  if ((await realpath(candidate)) !== candidate || (await realpath(root)) !== root) fail(`path changed: ${path}`);
  const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size <= 0) fail(`not a nonempty file: ${path}`);
    const digest = createHash('sha256');
    const chunk = Buffer.allocUnsafe(Math.min(before.size, 1024 * 1024));
    let position = 0;
    while (position < before.size) {
      const read = await handle.read(chunk, 0, Math.min(chunk.length, before.size - position), position);
      if (read.bytesRead <= 0) fail(`file shortened: ${path}`);
      digest.update(chunk.subarray(0, read.bytesRead));
      position += read.bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== before.size || after.dev !== before.dev || after.ino !== before.ino
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || (await realpath(candidate)) !== candidate) fail(`file changed during read: ${path}`);
    return { sha256: digest.digest('hex'), bytes: before.size };
  } finally { await handle.close(); }
}

async function image(bytes: Buffer, label: string): Promise<{ width: number; height: number; raw: Buffer }> {
  try {
    const decoded = await sharp(bytes, { failOn: 'error' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (decoded.info.width <= 0 || decoded.info.height <= 0) fail(`no image pixels: ${label}`);
    return { width: decoded.info.width, height: decoded.info.height, raw: decoded.data };
  } catch { return fail(`image cannot decode: ${label}`); }
}

export async function verifyEvidenceBundle(root: string, manifest: EvidenceBundleManifest): Promise<void> {
  const parsed = EvidenceBundleManifestSchema.parse(manifest);
  const physicalRoot = await rootPath(root);
  const keys = parsed.files.map((file) => portableKey(file.relativePath));
  if (new Set(keys).size !== keys.length) fail('portable filename collision');
  for (const file of parsed.files) {
    const actual = await hashBound(physicalRoot, file.relativePath);
    if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256) fail(`file changed: ${file.relativePath}`);
  }
}

export async function buildEvidenceBundle(input: EvidenceBundleInput): Promise<{ manifest: EvidenceBundleManifest; evidenceSha256: string }> {
  const request = input.request.schemaVersion === 2 ? RenderRequestV2Schema.parse(input.request) : RenderRequestSchema.parse(input.request);
  const evidence = input.evidence.schemaVersion === 2 ? RenderEvidenceV2Schema.parse(input.evidence) : RenderEvidenceSchema.parse(input.evidence);
  if (request.schemaVersion !== evidence.schemaVersion) fail('render protocol version mismatch');
  if (request.stagingDirectory !== input.root || request.jobId !== evidence.jobId || request.asset.assetId !== evidence.assetId || request.attempt !== evidence.attempt
    || request.asset.source.sha256 !== evidence.sourceSha256 || request.profile.profileSha256 !== evidence.profileSha256
    || request.profile.toolSchemaSha256 !== evidence.toolSchemaSha256) fail('render request binding mismatch');
  const root = await rootPath(input.root);
  const files = new Map<string, ManifestFile>();
  const images: VisionInput[] = [];
  const addFile = async (path: string, role: ManifestFile['role'], expectedSha?: string, expectedBytes?: number) => {
    const bytes = await readBound(root, path);
    const actualSha = sha256(bytes);
    if ((expectedSha && expectedSha !== actualSha) || (expectedBytes && expectedBytes !== bytes.length)) fail(`digest or size changed: ${path}`);
    const prior = files.get(path);
    if (prior && (prior.role !== role || prior.sha256 !== actualSha)) fail(`conflicting file role: ${path}`);
    files.set(path, { relativePath: path, role, sha256: actualSha, bytes: bytes.length });
    return bytes;
  };
  const addOpaqueFile = async (path: string, role: ManifestFile['role'], expectedSha?: string, expectedBytes?: number) => {
    const actual = await hashBound(root, path);
    if ((expectedSha && expectedSha !== actual.sha256) || (expectedBytes && expectedBytes !== actual.bytes)) fail(`digest or size changed: ${path}`);
    const prior = files.get(path);
    if (prior && (prior.role !== role || prior.sha256 !== actual.sha256)) fail(`conflicting file role: ${path}`);
    files.set(path, { relativePath: path, role, sha256: actual.sha256, bytes: actual.bytes });
  };
  const addImage = async (id: string, role: VisionInput['role'], path: string, variantId: VariantId | null, expectedSha?: string) => {
    const bytes = await addFile(path, role === 'output' ? 'artifact' : 'imageInput', expectedSha);
    const decoded = await image(bytes, path);
    const input: VisionInput = { id, role, relativePath: path, sha256: sha256(bytes), width: decoded.width, height: decoded.height,
      variantId, derivedFromSha256: sha256(bytes), crop: null };
    images.push(input);
    return { input, decoded };
  };
  const renderBytes = await addFile('render-evidence.json', 'renderEvidence');
  let stored: unknown;
  try { stored = JSON.parse(renderBytes.toString('utf8')); } catch { fail('render evidence JSON invalid'); }
  const storedEvidence = evidence.schemaVersion === 2 ? RenderEvidenceV2Schema.parse(stored) : RenderEvidenceSchema.parse(stored);
  if (canonicalize(storedEvidence) !== canonicalize(evidence)) fail('render evidence file differs from input');
  await addFile(evidence.documentTracePath, 'trace');
  await addFile(evidence.toolTracePath, 'trace');
  if (evidence.documentTracePath === evidence.toolTracePath || evidence.checks.length === 0 || evidence.checks.some((check) => !check.passed)) fail('trace/check evidence incomplete');
  for (const check of evidence.checks) await addFile(check.evidencePath, 'check');
  await addImage('source', 'source', input.sourcePath, null, request.asset.source.sha256);
  if (files.get(input.sourcePath)?.bytes !== request.asset.sourceBytes) fail('source byte count changed');
  if (request.schemaVersion === 2 && evidence.schemaVersion === 2) {
    if (request.operationId !== evidence.operationId || !evidence.released || input.sourcePath !== request.ownedInput.source.relativePath) fail('V2 owned source/release binding mismatch');
    const proofJson = async (ref: { relativePath: string; sha256: string }): Promise<unknown> => {
      const bytes = await addFile(ref.relativePath, files.get(ref.relativePath)?.role ?? 'check', ref.sha256);
      try { return JSON.parse(bytes.toString('utf8')) as unknown; } catch { return fail(`proof JSON invalid: ${ref.relativePath}`); }
    };
    const owned = OwnedInputProofV2Schema.parse(await proofJson(evidence.ownedInputProof));
    const template = TemplateClosureProofV2Schema.parse(await proofJson(evidence.templateClosureProof));
    const release = ReleaseProofV2Schema.parse(await proofJson(evidence.releaseProof));
    const identity = { schemaVersion: 2, jobId: request.jobId, assetId: request.asset.assetId, attempt: request.attempt, operationId: request.operationId };
    if (!validateTemplateClosureProofV2(template, request).success || !validateReleaseProofV2(release, identity).success
      || owned.jobId !== identity.jobId || owned.assetId !== identity.assetId || owned.attempt !== identity.attempt || owned.operationId !== identity.operationId
      || owned.sourceRootIdentity !== request.ownedInput.sourceRootIdentity || owned.openedSourceRelativePath !== input.sourcePath
      || owned.source.ownedRelativePath !== input.sourcePath || owned.source.original.sha256 !== request.asset.source.sha256
      || owned.source.copyAfterSha256 !== request.asset.source.sha256 || owned.dependencies.length !== request.ownedInput.dependencies.length) fail('V2 proof identity/closure mismatch');
    if (owned.closureProof.relativePath !== request.ownedInput.closureProof.relativePath || owned.closureProof.sha256 !== request.ownedInput.closureProof.sha256) fail('V2 linked closure proof differs from request');
    for (const dependency of request.ownedInput.dependencies) {
      const proved = owned.dependencies.find((entry) => entry.identity === dependency.identity);
      if (!proved || proved.ownedRelativePath !== dependency.relativePath || proved.copyAfterSha256 !== dependency.sha256
        || proved.original.sha256 !== dependency.original.sha256) fail('V2 linked dependency proof mismatch');
      await addOpaqueFile(dependency.relativePath, 'check');
    }
    await proofJson(request.ownedInput.closureProof);
    await proofJson(template.documentTrace);
    await addFile(release.ownerSnapshot.relativePath, 'check', release.ownerSnapshot.sha256);
    await addFile(release.journalSnapshot.relativePath, 'check', release.journalSnapshot.sha256);
    for (const entry of template.closureEntries) await addOpaqueFile(entry.ownedRelativePath, 'check');
  }
  if (input.references.length !== 3 || input.details.length < 3) fail('three references and output details required');
  for (const id of ids) {
    const artifact = evidence.artifacts.find((item) => item.variantId === id)!;
    const ref = input.references.filter((item) => item.variantId === id);
    const detail = input.details.filter((item) => item.variantId === id);
    if (ref.length !== 1 || detail.length === 0) fail(`reference/detail set incomplete for ${id}`);
    if (ref[0]!.qualificationId !== request.profile.qualificationId) fail(`reference qualification mismatch for ${id}`);
    await addImage(`reference-${id}`, 'reference', ref[0]!.path, id, ref[0]!.sha256);
    const output = await addImage(`output-${id}`, 'output', artifact.path, id, artifact.sha256);
    if (files.get(artifact.path)?.bytes !== artifact.bytes || output.decoded.width !== artifact.width || output.decoded.height !== artifact.height) fail(`artifact metadata mismatch for ${id}`);
    for (const [index, item] of detail.entries()) {
      if (item.derivedFromPath !== artifact.path) fail(`detail derivation mismatch for ${id}`);
      const crop = item.crop;
      if (![crop.left, crop.top, crop.right, crop.bottom].every(Number.isSafeInteger) || crop.left < 0 || crop.top < 0
        || crop.right > output.decoded.width || crop.bottom > output.decoded.height || crop.right <= crop.left || crop.bottom <= crop.top
        || (crop.left === 0 && crop.top === 0 && crop.right === output.decoded.width && crop.bottom === output.decoded.height)) fail(`detail crop invalid for ${id}`);
      const detailBytes = await addFile(item.path, 'imageInput');
      const decoded = await image(detailBytes, item.path);
      const width = crop.right - crop.left, height = crop.bottom - crop.top;
      if (decoded.width !== width || decoded.height !== height) fail(`detail crop dimensions mismatch for ${id}`);
      const extracted = await sharp(await readBound(root, artifact.path)).extract({ left: crop.left, top: crop.top, width, height }).ensureAlpha().raw().toBuffer();
      if (!decoded.raw.equals(extracted)) fail(`detail crop pixels differ from output for ${id}`);
      images.push({ id: `detail-${id}-${index + 1}`, role: 'detail', relativePath: item.path, sha256: sha256(detailBytes), width, height,
        variantId: id, derivedFromSha256: artifact.sha256, crop });
    }
  }
  const manifest = EvidenceBundleManifestSchema.parse({ schemaVersion: 1, jobId: request.jobId, assetId: request.asset.assetId, attempt: request.attempt,
    files: [...files.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath)), visionInputs: images });
  await verifyEvidenceBundle(root, manifest);
  return { manifest, evidenceSha256: bundleDigest(manifest) };
}
