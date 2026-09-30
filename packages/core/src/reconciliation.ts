import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, readdir, rename } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { bundleDigest, canonicalize, EvidenceBundleManifestSchema } from '@ne-psd/contracts';
import { filesystemIdentity, type PublicationIntent } from './job-repository.js';
import { verifyEvidenceBundle } from './evidence-bundle.js';
import { committedManifestName, type CommittedManifest } from './publication.js';

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function assertBoundDestination(intent: PublicationIntent): Promise<void> {
  const root = intent.outputRootPath;
  if (!isAbsolute(root) || await realpath(root) !== root || filesystemIdentity(root) !== intent.outputRootIdentity
    || !inside(root, intent.destinationPath) || !inside(root, dirname(intent.destinationPath))
    || await realpath(dirname(intent.destinationPath)) !== dirname(intent.destinationPath)) throw new Error('publication root identity or destination changed');
}

export async function inspectCommittedDirectory(intent: PublicationIntent): Promise<'missing' | 'valid' | 'corrupt'> {
  await assertBoundDestination(intent);
  let info;
  try { info = await lstat(intent.destinationPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(intent.destinationPath) !== intent.destinationPath) return 'corrupt';
  try {
    const text = await readFile(join(intent.destinationPath, committedManifestName), 'utf8');
    const committed = JSON.parse(text) as CommittedManifest;
    const manifest = EvidenceBundleManifestSchema.parse(committed.manifest);
    if (text !== canonicalize(committed) || committed.schemaVersion !== 1
      || committed.transactionKey !== intent.transactionKey
      || committed.manifestSha256 !== intent.manifestSha256 || bundleDigest(manifest) !== intent.manifestSha256
      || committed.reviewId !== intent.reviewId || committed.decisionSha256 !== intent.decisionSha256
      || committed.reviewPolicySha256 !== intent.reviewPolicySha256
      || committed.modelProvenanceSha256 !== intent.modelProvenanceSha256
      || manifest.jobId !== intent.jobId || manifest.assetId !== intent.assetId || manifest.attempt !== intent.attempt
      || manifest.files.filter((file) => file.role === 'artifact').length !== 3) return 'corrupt';
    const expected = new Set([committedManifestName, ...manifest.files.map((file) => file.relativePath)]);
    const actual = await collectFiles(intent.destinationPath);
    if (actual.length !== expected.size || actual.some((path) => !expected.has(path))) return 'corrupt';
    await verifyEvidenceBundle(intent.destinationPath, manifest);
    return 'valid';
  } catch { return 'corrupt'; }
}

async function collectFiles(root: string, prefix = ''): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error('symlink in publication');
    if (entry.isDirectory()) paths.push(...await collectFiles(root, rel));
    else if (entry.isFile()) paths.push(rel);
    else throw new Error('special file in publication');
  }
  return paths;
}

export async function quarantineCommittedDirectory(intent: PublicationIntent): Promise<string> {
  await assertBoundDestination(intent);
  const info = await lstat(intent.destinationPath);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('committed destination is not an owned directory');
  const quarantineRoot = join(intent.outputRootPath, 'quarantine');
  await mkdir(quarantineRoot, { recursive: true });
  if (await realpath(quarantineRoot) !== quarantineRoot) throw new Error('quarantine root changed');
  const quarantinePath = join(quarantineRoot, randomUUID());
  await assertBoundDestination(intent);
  await rename(intent.destinationPath, quarantinePath);
  return quarantinePath;
}
