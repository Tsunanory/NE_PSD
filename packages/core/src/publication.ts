import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, rename, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { platform } from 'node:os';
import {
  bundleDigest, canonicalize, EvidenceBundleManifestSchema, ReviewDecisionSchema, sha256Json,
  type EvidenceBundleManifest,
} from '@ne-psd/contracts';
import { filesystemIdentity, type PublicationIntent } from './job-repository.js';
import { verifyEvidenceBundle } from './evidence-bundle.js';
import type { ReviewGateResult } from './review-gate.js';

export const committedManifestName = 'committed-manifest.json';
export type CommittedManifest = {
  schemaVersion: 1;
  transactionKey: string;
  manifestSha256: string;
  reviewId: string;
  decisionSha256: string;
  reviewPolicySha256: string;
  modelProvenanceSha256: string;
  manifest: EvidenceBundleManifest;
};

const fail = (message: string): never => { throw new Error(`PUBLICATION_INVALID: ${message}`); };
const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

async function boundDirectory(root: string, path: string): Promise<void> {
  if (!inside(root, path)) fail('directory escapes output root');
  for (let current = path; current !== root; current = dirname(current)) {
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(current) !== current) fail('directory path is not physical');
  }
}

export async function validatePublicationRoot(intent: PublicationIntent): Promise<void> {
  const root = intent.outputRootPath;
  if (!isAbsolute(root) || await realpath(root) !== root || filesystemIdentity(root) !== intent.outputRootIdentity) fail('output root identity changed');
  await boundDirectory(root, intent.stagingDirectory);
  await boundDirectory(root, dirname(intent.destinationPath));
  if (!inside(root, intent.destinationPath) || intent.destinationPath === intent.stagingDirectory) fail('invalid destination');
  if ((await stat(intent.stagingDirectory)).dev !== (await stat(dirname(intent.destinationPath))).dev) fail('cross-volume rename');
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (platform() !== 'win32' || !['EINVAL', 'EISDIR', 'EPERM', 'ENOTSUP'].includes(code ?? '')) throw error;
  } finally { await handle?.close(); }
}

async function syncTree(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) fail('symlink in staged bundle');
    if (entry.isDirectory()) await syncTree(path);
    else if (entry.isFile()) {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await handle.sync(); } finally { await handle.close(); }
    } else fail('special file in staged bundle');
  }
  await syncDirectory(root);
}

async function stagedFiles(root: string, prefix = ''): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) fail('symlink in staged bundle');
    if (entry.isDirectory()) paths.push(...await stagedFiles(root, rel));
    else if (entry.isFile()) paths.push(rel);
    else fail('special file in staged bundle');
  }
  return paths;
}

export function committedManifest(intent: PublicationIntent, manifest: EvidenceBundleManifest, review: ReviewGateResult): CommittedManifest {
  if (intent.state !== 'prepared') fail('persisted intent required');
  if (review.status !== 'passed') throw new Error('PUBLICATION_INVALID: passed review required');
  const parsed = EvidenceBundleManifestSchema.parse(manifest);
  const decision = ReviewDecisionSchema.parse(review.decision);
  const digest = bundleDigest(parsed);
  if (intent.jobId !== parsed.jobId || intent.assetId !== parsed.assetId || intent.attempt !== parsed.attempt
    || intent.transactionKey !== `${parsed.jobId}:${parsed.assetId}:${parsed.attempt}`
    || intent.manifestSha256 !== digest || review.evidenceSha256 !== digest
    || decision.jobId !== parsed.jobId || decision.assetId !== parsed.assetId || decision.attempt !== parsed.attempt
    || decision.evidenceSha256 !== digest || decision.verdict !== 'pass'
    || decision.variantChecks.some((check) => check.verdict !== 'pass')
    || decision.checks.some((check) => check.result !== 'pass')
    || intent.reviewId !== decision.reviewId || intent.decisionSha256 !== sha256Json(decision)
    || intent.reviewPolicySha256 !== decision.reviewPolicySha256
    || intent.modelProvenanceSha256 !== sha256Json(decision.modelProvenance)) fail('intent, evidence and review binding mismatch');
  if (parsed.files.filter((file) => file.role === 'artifact').length !== 3
    || parsed.files.some((file) => file.relativePath === committedManifestName)) fail('invalid committed file set');
  return { schemaVersion: 1, transactionKey: intent.transactionKey, manifestSha256: digest,
    reviewId: intent.reviewId, decisionSha256: intent.decisionSha256,
    reviewPolicySha256: intent.reviewPolicySha256, modelProvenanceSha256: intent.modelProvenanceSha256,
    manifest: parsed };
}

export async function publishStagedDirectory(intent: PublicationIntent, manifest: EvidenceBundleManifest, review: ReviewGateResult): Promise<void> {
  const committed = committedManifest(intent, manifest, review);
  await validatePublicationRoot(intent);
  await verifyEvidenceBundle(intent.stagingDirectory, manifest);
  const sealedPaths = new Set(manifest.files.map((file) => file.relativePath));
  if ((await stagedFiles(intent.stagingDirectory)).some((path) => !sealedPaths.has(path))) fail('unlisted staged file is not sealed');
  if (await lstat(intent.destinationPath).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  })) fail('destination already exists');
  const handle = await open(join(intent.stagingDirectory, committedManifestName), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { await handle.writeFile(canonicalize(committed)); await handle.sync(); } finally { await handle.close(); }
  await syncTree(intent.stagingDirectory);
  await verifyEvidenceBundle(intent.stagingDirectory, manifest);
  await validatePublicationRoot(intent);
  await syncDirectory(dirname(intent.stagingDirectory));
  await syncDirectory(dirname(intent.destinationPath));
  if (await lstat(intent.destinationPath).then(() => true, () => false)) fail('destination already exists');
  await rename(intent.stagingDirectory, intent.destinationPath);
  await syncDirectory(dirname(intent.destinationPath));
}
