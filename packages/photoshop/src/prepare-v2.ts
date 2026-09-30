import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import sharp from 'sharp';
import {
  canonicalize, PrepareRequestV2Schema, PreparedInputManifestV2Schema,
  type PrepareRequestV2, type PreparedInputManifestV2,
} from '@ne-psd/contracts';
import type { LinkedResource } from './working-copy.js';

export type AssetLinkScan = { sourceSha256: string; complete: true; links: readonly LinkedResource[] };
export type AssetLinkScanner = {
  /** Read-only, qualified PSD/PSB discovery; an empty list requires a complete byte-bound scan. */
  readLinks(path: string, signal: AbortSignal): Promise<AssetLinkScan>;
};
export const ASSET_CLOSURE_PROOF_V2_PATH = 'checks/asset-closure.json';
export const PREPARED_INPUT_MANIFEST_V2_PATH = 'checks/prepared-input-manifest.json';

type ObservedFile = { path: string; relativePath: string; sha256: string; bytes: number; identity: string };
type ObservedEdge = { parent: string; child: string; identity: string };
const hex = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const inside = (root: string, candidate: string): boolean => {
  const rel = relative(root, candidate);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
};
const errorCode = (cause: unknown): string => cause instanceof PrepareError ? cause.code : (cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' ? 'SOURCE_MISSING' : (cause as NodeJS.ErrnoException | undefined)?.code === 'EEXIST' ? 'PROOF_ALREADY_EXISTS' : 'ASSET_PREPARATION_FAILED';

class PrepareError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'PrepareError'; }
}

async function noSymlinkComponents(path: string): Promise<void> {
  const parts: string[] = [];
  let current = resolve(path);
  while (dirname(current) !== current) { parts.unshift(current); current = dirname(current); }
  for (const part of parts) {
    const entry = await lstat(part);
    if (entry.isSymbolicLink()) throw new PrepareError('SOURCE_SYMLINK', 'symlinked path component: ' + part);
  }
}
export async function sourceRootIdentity(path: string): Promise<{ root: string; identity: string }> {
  await noSymlinkComponents(path);
  const root = await realpath(path);
  const info = await stat(root);
  if (!info.isDirectory()) throw new PrepareError('SOURCE_ROOT_INVALID', 'selected source root is not a directory');
  return { root, identity: hex(root + '|' + info.dev + '|' + info.ino) };
}
async function canonicalFile(root: string, path: string): Promise<string> {
  if (!inside(root, resolve(path))) throw new PrepareError('SOURCE_ESCAPE', 'source escapes selected root');
  await noSymlinkComponents(path);
  const canonical = await realpath(path);
  if (!inside(root, canonical) || !(await stat(canonical)).isFile()) throw new PrepareError('SOURCE_ESCAPE', 'source is not a confined regular file');
  return canonical;
}
async function bytesOf(path: string): Promise<{ sha256: string; bytes: number }> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size <= 0) throw new PrepareError('SOURCE_INVALID', 'source is not a nonempty regular file');
    const bytes = await handle.readFile();
    return { sha256: hex(bytes), bytes: bytes.byteLength };
  } finally { await handle.close(); }
}
async function rasterLinkFree(path: string, extension: string): Promise<void> {
  try {
    const image = sharp(path, { failOn: 'error' });
    const metadata = await image.metadata();
    if (metadata.format !== (extension === '.jpg' ? 'jpeg' : extension.slice(1))) throw new Error('format differs from extension');
    await sharp(path, { failOn: 'error' }).stats();
  } catch (error) { throw new PrepareError('RASTER_INVALID', 'strict image decode failed: ' + String(error)); }
}
async function writeObservedProof(stagingRoot: string, relativePath: string, bytes: Buffer): Promise<void> {
  const checksRoot = join(stagingRoot, 'checks');
  try { await mkdir(checksRoot); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  await noSymlinkComponents(checksRoot);
  if ((await realpath(checksRoot)) !== checksRoot || !(await stat(checksRoot)).isDirectory()) throw new PrepareError('PROOF_PATH_INVALID', 'checks directory is not a real directory');
  const path = join(stagingRoot, relativePath);
  await writeFile(path, bytes, { flag: 'wx' });
  await noSymlinkComponents(path);
  if ((await realpath(path)) !== path || hex(await readFile(path)) !== hex(bytes)) throw new PrepareError('PROOF_WRITE_FAILED', 'proof changed after write');
}
function base(request: PrepareRequestV2) {
  return {
    schemaVersion: 2 as const, jobId: request.jobId, assetId: request.asset.assetId,
    attempt: request.attempt, operationId: request.operationId,
    stagingDirectory: request.stagingDirectory,
    profileSha256: request.profile.profileSha256, template: request.profile.template,
    sourceSha256: request.asset.source.sha256, sourceRootId: request.sourceRoot.rootId,
    sourceRootPath: request.sourceRoot.path, sourceRootIdentity: request.sourceRoot.identity,
    scratchDirectory: request.scratchDirectory,
  };
}
function blocked(request: PrepareRequestV2, cause: unknown): PreparedInputManifestV2 {
  const code = errorCode(cause);
  const category = code === 'LINK_SCAN_UNAVAILABLE' ? 'capability' : code === 'CANCELLED' ? 'cancelled' : 'validation';
  return PreparedInputManifestV2Schema.parse({
    ...base(request), status: 'blocked',
    errors: [{ code, category, message: cause instanceof Error ? cause.message : String(cause), retryable: false, evidencePaths: [] }],
    evidencePaths: [],
  });
}

/**
 * Observe the selected asset and all of its linked source files before A copies them.
 * The B backend invokes this under its sole installation lock. This function itself
 * never opens Photoshop, copies a source, or mutates/relinks an original.
 */
export async function prepareOwnedInputV2(requestValue: PrepareRequestV2, scanner: AssetLinkScanner, signal: AbortSignal): Promise<PreparedInputManifestV2> {
  const request = PrepareRequestV2Schema.parse(requestValue);
  const checkCancelled = () => { if (signal.aborted) throw new PrepareError('CANCELLED', 'preparation cancelled'); };
  try {
    checkCancelled();
    const { root, identity: rootIdentity } = await sourceRootIdentity(request.sourceRoot.path);
    checkCancelled();
    if (rootIdentity !== request.sourceRoot.identity) throw new PrepareError('SOURCE_ROOT_CHANGED', 'source root identity differs from A binding');
    await noSymlinkComponents(request.stagingDirectory);
    checkCancelled();
    const stagingRoot = await realpath(request.stagingDirectory);
    checkCancelled();
    if (!(await stat(stagingRoot)).isDirectory() || stagingRoot !== resolve(request.stagingDirectory)) throw new PrepareError('STAGING_ROOT_INVALID', 'staging root is not canonical');
    checkCancelled();
    if (inside(root, stagingRoot) || inside(stagingRoot, root) || root === stagingRoot) throw new PrepareError('ROOT_OVERLAP', 'staging and source roots overlap');
    const sourcePath = await canonicalFile(root, resolve(root, ...request.asset.source.relativePath.split('/')));
    checkCancelled();
    const observed = new Map<string, ObservedFile>();
    const visiting = new Set<string>();
    const edges: ObservedEdge[] = [];
    const visit = async (path: string): Promise<ObservedFile> => {
      checkCancelled();
      const canonical = await canonicalFile(root, path);
      checkCancelled();
      if (visiting.has(canonical)) throw new PrepareError('LINK_CYCLE', 'linked source cycle');
      const known = observed.get(canonical);
      if (known) return known;
      const measured = await bytesOf(canonical);
      checkCancelled();
      const relativePath = relative(root, canonical).split(sep).join('/');
      const entry = { path: canonical, relativePath, ...measured, identity: hex(request.sourceRoot.rootId + '\0' + relativePath) };
      observed.set(canonical, entry);
      visiting.add(canonical);
      const extension = extname(canonical).toLowerCase();
      if (extension === '.png' || extension === '.jpg' || extension === '.jpeg') {
        await rasterLinkFree(canonical, extension === '.jpeg' ? '.jpg' : extension);
        checkCancelled();
      } else if (extension === '.psd' || extension === '.psb') {
        let scan: AssetLinkScan;
        try { scan = await scanner.readLinks(canonical, signal); }
        catch (error) {
          checkCancelled();
          throw new PrepareError('LINK_SCAN_UNAVAILABLE', 'qualified asset link scan failed: ' + String(error));
        }
        checkCancelled();
        if (scan?.complete !== true || scan.sourceSha256 !== measured.sha256 || !Array.isArray(scan.links)) throw new PrepareError('LINK_SCAN_UNAVAILABLE', 'link scanner did not prove a complete scan of these bytes');
        for (const link of scan.links) {
          if (link.sourceKind === 'embedded') continue;
          if (link.sourceKind !== 'linked' || !link.path) throw new PrepareError('LINK_UNKNOWN', 'PSD/PSB has an unknown or missing linked source');
          const target = isAbsolute(link.path) ? link.path : resolve(dirname(canonical), link.path);
          const child = await visit(target);
          checkCancelled();
          if (link.expectedSha256 && link.expectedSha256 !== child.sha256) throw new PrepareError('LINK_HASH_MISMATCH', 'linked source differs from scanner expectation');
          edges.push({ parent: entry.relativePath, child: child.relativePath, identity: child.identity });
        }
      } else throw new PrepareError('ASSET_TYPE_UNSUPPORTED', 'asset type needs a qualified link scanner or strict raster decoder');
      const after = await bytesOf(canonical);
      checkCancelled();
      if (after.sha256 !== measured.sha256 || after.bytes !== measured.bytes) throw new PrepareError('SOURCE_CHANGED', 'source changed during link discovery');
      visiting.delete(canonical);
      return entry;
    };
    const source = await visit(sourcePath);
    checkCancelled();
    if (source.sha256 !== request.asset.source.sha256 || source.bytes !== request.asset.sourceBytes) throw new PrepareError('SOURCE_CHANGED', 'selected asset bytes differ from request');
    for (const item of observed.values()) {
      const after = await bytesOf(item.path);
      checkCancelled();
      if (after.sha256 !== item.sha256 || after.bytes !== item.bytes) throw new PrepareError('SOURCE_CHANGED', 'dependency changed during link discovery');
    }
    const dependencies = [...observed.values()].filter((item) => item.path !== source.path).sort((a, b) => a.relativePath.localeCompare(b.relativePath)).map((item) => ({
      identity: item.identity, sourceKind: 'linked' as const,
      original: { rootId: request.sourceRoot.rootId, relativePath: item.relativePath, sha256: item.sha256 },
      bytes: item.bytes,
    }));
    const proofData = {
      schemaVersion: 2, jobId: request.jobId, assetId: request.asset.assetId,
      attempt: request.attempt, operationId: request.operationId,
      sourceRootIdentity: rootIdentity, source: { relativePath: source.relativePath, sha256: source.sha256, bytes: source.bytes },
      dependencies, observedLinks: edges.sort((a, b) => (a.parent + a.child).localeCompare(b.parent + b.child)), closureComplete: true,
    };
    const proofBytes = Buffer.from(canonicalize(proofData));
    checkCancelled();
    await writeObservedProof(stagingRoot, ASSET_CLOSURE_PROOF_V2_PATH, proofBytes);
    checkCancelled();
    const manifest = PreparedInputManifestV2Schema.parse({
      ...base(request), status: 'prepared',
      source: { original: request.asset.source, bytes: source.bytes },
      dependencies, closureComplete: true,
      closureProof: { relativePath: ASSET_CLOSURE_PROOF_V2_PATH, sha256: hex(proofBytes) },
    });
    checkCancelled();
    await writeObservedProof(stagingRoot, PREPARED_INPUT_MANIFEST_V2_PATH, Buffer.from(canonicalize(manifest)));
    checkCancelled();
    return manifest;
  } catch (cause) { return blocked(request, signal.aborted ? new PrepareError('CANCELLED', 'preparation cancelled') : cause); }
}
