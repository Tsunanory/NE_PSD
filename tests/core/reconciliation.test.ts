import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { bundleDigest, sha256Json, type EvidenceBundleManifest, type ReviewDecision } from '@ne-psd/contracts';
import { filesystemIdentity, type PublicationIntent } from '../../packages/core/src/job-repository.js';
import { publishStagedDirectory } from '../../packages/core/src/publication.js';
import { inspectCommittedDirectory, quarantineCommittedDirectory } from '../../packages/core/src/reconciliation.js';
import type { ReviewGateResult } from '../../packages/core/src/review-gate.js';
import { readFixture } from '../fixtures/read-fixture.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ne-psd-reconcile-')));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const stagingDirectory = join(root, 'staging', 'tx');
  const destinationPath = join(root, 'published', 'tx');
  await mkdir(stagingDirectory, { recursive: true });
  await mkdir(join(root, 'published'));
  const files: EvidenceBundleManifest['files'] = [];
  for (const id of ['1', '2', '3']) {
    const relativePath = `variant-${id}.png`;
    const bytes = `image-${id}`;
    await writeFile(join(stagingDirectory, relativePath), bytes);
    files.push({ relativePath, role: 'artifact', sha256: hash(bytes), bytes: Buffer.byteLength(bytes) });
  }
  const manifest: EvidenceBundleManifest = { schemaVersion: 1, jobId: 'job-1', assetId: 'asset-1', attempt: 1, files, visionInputs: [] };
  const decision = structuredClone(readFixture<ReviewDecision>('review.pass.json'));
  decision.evidenceSha256 = bundleDigest(manifest);
  const review: Extract<ReviewGateResult, { status: 'passed' }> = { status: 'passed', decision, evidenceSha256: bundleDigest(manifest) };
  const intent: PublicationIntent = { jobId: manifest.jobId, assetId: manifest.assetId, attempt: 1, transactionKey: 'job-1:asset-1:1',
    outputRootPath: root, outputRootIdentity: filesystemIdentity(root), stagingDirectory, destinationPath,
    manifestSha256: bundleDigest(manifest), reviewId: decision.reviewId, decisionSha256: sha256Json(decision),
    reviewPolicySha256: decision.reviewPolicySha256, modelProvenanceSha256: sha256Json(decision.modelProvenance), state: 'prepared' };
  return { root, stagingDirectory, destinationPath, manifest, review, intent };
}

describe('publication reconciliation', () => {
  it('recognizes a complete rename using the persisted transaction identity', async () => {
    const f = await fixture();
    expect(await inspectCommittedDirectory(f.intent)).toBe('missing');
    await publishStagedDirectory(f.intent, f.manifest, f.review);
    expect(await inspectCommittedDirectory(f.intent)).toBe('valid');
  });

  it('detects changed committed bytes and retains them in controlled quarantine', async () => {
    const f = await fixture();
    await publishStagedDirectory(f.intent, f.manifest, f.review);
    await writeFile(join(f.destinationPath, 'variant-2.png'), 'corrupt');
    expect(await inspectCommittedDirectory(f.intent)).toBe('corrupt');
    const quarantinePath = await quarantineCommittedDirectory(f.intent);
    expect(quarantinePath).toMatch(/\/quarantine\//);
    expect(await readFile(join(quarantinePath, 'variant-2.png'), 'utf8')).toBe('corrupt');
    expect(await inspectCommittedDirectory(f.intent)).toBe('missing');
  });

  it('never quarantines a destination after root identity changes', async () => {
    const f = await fixture();
    await publishStagedDirectory(f.intent, f.manifest, f.review);
    await expect(quarantineCommittedDirectory({ ...f.intent, outputRootIdentity: '0'.repeat(64) })).rejects.toThrow();
    expect(await inspectCommittedDirectory(f.intent)).toBe('valid');
  });
});
