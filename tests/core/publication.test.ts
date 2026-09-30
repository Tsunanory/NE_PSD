import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { bundleDigest, canonicalize, sha256Json, type EvidenceBundleManifest, type ReviewDecision } from '@ne-psd/contracts';
import { filesystemIdentity, type PublicationIntent } from '../../packages/core/src/job-repository.js';
import { committedManifest, publishStagedDirectory } from '../../packages/core/src/publication.js';
import type { ReviewGateResult } from '../../packages/core/src/review-gate.js';
import { readFixture } from '../fixtures/read-fixture.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ne-psd-publish-')));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const stagingDirectory = join(root, 'staging', 'transaction-one');
  const destinationPath = join(root, 'published', 'transaction-one');
  await mkdir(stagingDirectory, { recursive: true });
  await mkdir(join(root, 'published'));
  const files: EvidenceBundleManifest['files'] = [];
  for (const id of ['1', '2', '3'] as const) {
    const relativePath = `variant-${id}.png`;
    const bytes = `image-${id}`;
    await writeFile(join(stagingDirectory, relativePath), bytes);
    files.push({ relativePath, role: 'artifact', sha256: hash(bytes), bytes: Buffer.byteLength(bytes) });
  }
  const manifest: EvidenceBundleManifest = { schemaVersion: 1, jobId: 'job-1', assetId: 'asset-1', attempt: 1, files, visionInputs: [] };
  const decision = structuredClone(readFixture<ReviewDecision>('review.pass.json'));
  decision.evidenceSha256 = bundleDigest(manifest);
  const review: Extract<ReviewGateResult, { status: 'passed' }> = { status: 'passed', decision, evidenceSha256: bundleDigest(manifest) };
  const intent: PublicationIntent = {
    jobId: manifest.jobId, assetId: manifest.assetId, attempt: manifest.attempt,
    transactionKey: `${manifest.jobId}:${manifest.assetId}:${manifest.attempt}`,
    outputRootPath: root, outputRootIdentity: filesystemIdentity(root), stagingDirectory, destinationPath,
    manifestSha256: bundleDigest(manifest), reviewId: decision.reviewId,
    decisionSha256: sha256Json(decision), reviewPolicySha256: decision.reviewPolicySha256,
    modelProvenanceSha256: sha256Json(decision.modelProvenance), state: 'prepared',
  };
  return { root, stagingDirectory, destinationPath, intent, manifest, review };
}

describe('whole-directory publication', () => {
  it('renames one verified bundle with a canonical committed manifest', async () => {
    const f = await fixture();
    await publishStagedDirectory(f.intent, f.manifest, f.review);
    expect(await readdir(f.destinationPath)).toEqual(['committed-manifest.json', 'variant-1.png', 'variant-2.png', 'variant-3.png']);
    expect(JSON.parse(await readFile(join(f.destinationPath, 'committed-manifest.json'), 'utf8'))).toMatchObject({
      transactionKey: f.intent.transactionKey, manifestSha256: f.intent.manifestSha256,
      decisionSha256: f.intent.decisionSha256, manifest: f.manifest,
    });
    await expect(readFile(join(f.stagingDirectory, 'variant-1.png'))).rejects.toThrow();
  });

  it('rejects changed artifact bytes before rename', async () => {
    const f = await fixture();
    await writeFile(join(f.stagingDirectory, 'variant-2.png'), 'changed');
    await expect(publishStagedDirectory(f.intent, f.manifest, f.review)).rejects.toThrow();
    expect(await readdir(join(f.root, 'published'))).toEqual([]);
  });

  it('rejects a staged file omitted from the sealed manifest', async () => {
    const f = await fixture();
    await writeFile(join(f.stagingDirectory, 'private-copy.psd'), 'not sealed');
    await expect(publishStagedDirectory(f.intent, f.manifest, f.review)).rejects.toThrow(/unlisted|sealed/i);
    expect(await readdir(join(f.root, 'published'))).toEqual([]);
  });

  it('refuses an occupied destination without replacing it', async () => {
    const f = await fixture();
    await mkdir(f.destinationPath);
    await writeFile(join(f.destinationPath, 'foreign.txt'), 'keep');
    await expect(publishStagedDirectory(f.intent, f.manifest, f.review)).rejects.toThrow();
    expect(await readFile(join(f.destinationPath, 'foreign.txt'), 'utf8')).toBe('keep');
  });

  it('resumes a crash after the committed manifest was synced but before rename', async () => {
    const f = await fixture();
    await writeFile(join(f.stagingDirectory, 'committed-manifest.json'), canonicalize(committedManifest(f.intent, f.manifest, f.review)));
    await publishStagedDirectory(f.intent, f.manifest, f.review);
    expect(await readdir(f.destinationPath)).toHaveLength(4);
  });

  it('rejects a changed output root and unpassed review', async () => {
    const f = await fixture();
    await expect(publishStagedDirectory({ ...f.intent, outputRootIdentity: '0'.repeat(64) }, f.manifest, f.review)).rejects.toThrow();
    await expect(publishStagedDirectory(f.intent, f.manifest, { status: 'blocked', reason: 'no visual proof', evidenceSha256: f.review.evidenceSha256 })).rejects.toThrow();
    expect(await readdir(join(f.root, 'published'))).toEqual([]);
  });
});
