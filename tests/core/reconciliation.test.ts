import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { bundleDigest, sha256Json, type EvidenceBundleManifest, type ReviewDecision } from '@ne-psd/contracts';
import { filesystemIdentity, JobRepository, type PublicationIntent } from '../../packages/core/src/job-repository.js';
import { publishReviewedAsset, publishStagedDirectory } from '../../packages/core/src/publication.js';
import { inspectCommittedDirectory, quarantineCommittedDirectory, reconcilePendingPublications } from '../../packages/core/src/reconciliation.js';
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

function persisted(f: Awaited<ReturnType<typeof fixture>>) {
  const path = join(f.root, 'state.sqlite');
  const repository = new JobRepository(path);
  const job = structuredClone(readFixture<import('@ne-psd/contracts').JobSpec>('job.interactive.json'));
  repository.recordQualification({ qualificationId: job.profile.qualificationId, profileId: job.profile.profileId,
    profileSha256: job.profile.profileSha256, profile: job.profile, evidence: { source: 'fixture' } });
  repository.createJob(job, null, { rootId: job.outputRootId, canonicalRoot: f.root, canonicalRootIdentity: f.intent.outputRootIdentity });
  repository.transition(job.jobId, job.assets[0]!.assetId, 'rendering');
  repository.transition(job.jobId, job.assets[0]!.assetId, 'reviewing');
  repository.recordReview({ reviewId: f.review.decision.reviewId, jobId: job.jobId,
    assetId: job.assets[0]!.assetId, attempt: 1, payload: f.review.decision });
  repository.transition(job.jobId, job.assets[0]!.assetId, 'readyToCommit');
  return { repository, path };
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

  it('refuses to quarantine a valid committed publication', async () => {
    const f = await fixture();
    await publishStagedDirectory(f.intent, f.manifest, f.review);
    await expect(quarantineCommittedDirectory(f.intent)).rejects.toThrow(/valid/i);
    expect(await inspectCommittedDirectory(f.intent)).toBe('valid');
  });

  it('reopens a rename-before-SQLite crash and completes exactly one publication', async () => {
    const f = await fixture();
    const db = persisted(f);
    const intent = db.repository.beginPublicationIntent(f.intent);
    await publishStagedDirectory(intent, f.manifest, f.review);
    db.repository.close();
    const reopened = new JobRepository(db.path);
    expect(reopened.listPendingPublicationIntents()).toHaveLength(1);
    expect(await reconcilePendingPublications(reopened)).toEqual([{ transactionKey: intent.transactionKey, result: 'completed' }]);
    expect(reopened.listPublications(intent.jobId)).toHaveLength(1);
    expect(reopened.getPublicationIntent(intent.jobId, intent.assetId, intent.attempt)?.state).toBe('committed');
    const committed = JSON.parse(await readFile(join(f.destinationPath, 'committed-manifest.json'), 'utf8'));
    expect(() => reopened.completePublicationIntent(intent, { publicationId: intent.transactionKey, jobId: intent.jobId,
      assetId: intent.assetId, attempt: intent.attempt, transactionKey: intent.transactionKey,
      path: intent.destinationPath, manifest: committed })).not.toThrow();
    expect(await reconcilePendingPublications(reopened)).toEqual([]);
    expect(reopened.listPublications(intent.jobId)).toHaveLength(1);
    reopened.close();
  });

  it('keeps the pre-rename intent pending and rejects conflicting replay', async () => {
    const f = await fixture();
    const db = persisted(f);
    const intent = db.repository.beginPublicationIntent(f.intent);
    expect(() => db.repository.beginPublicationIntent({ ...f.intent, destinationPath: join(f.root, 'published', 'other') })).toThrow(/conflict/i);
    expect(db.repository.beginPublicationIntent(f.intent)).toEqual(intent);
    expect(await reconcilePendingPublications(db.repository)).toEqual([]);
    expect(db.repository.listPendingPublicationIntents()).toHaveLength(1);
    expect(db.repository.listPublications(intent.jobId)).toHaveLength(0);
    db.repository.close();
  });

  it('refuses a persisted aggregate pass with a failed variant', async () => {
    const f = await fixture();
    f.review.decision.variantChecks[1]!.verdict = 'fail';
    f.intent.decisionSha256 = sha256Json(f.review.decision);
    const db = persisted(f);
    expect(() => db.repository.beginPublicationIntent(f.intent)).toThrow(/review|variant/i);
    expect(db.repository.listPendingPublicationIntents()).toEqual([]);
    db.repository.close();
  });

  it('quarantines a corrupt renamed directory without committing SQLite', async () => {
    const f = await fixture();
    const db = persisted(f);
    const intent = db.repository.beginPublicationIntent(f.intent);
    await publishStagedDirectory(intent, f.manifest, f.review);
    await writeFile(join(f.destinationPath, 'variant-2.png'), 'corrupt');
    expect(await reconcilePendingPublications(db.repository)).toEqual([{ transactionKey: intent.transactionKey, result: 'quarantined' }]);
    expect(db.repository.listPublications(intent.jobId)).toHaveLength(0);
    expect(db.repository.getPublicationIntent(intent.jobId, intent.assetId, intent.attempt)?.state).toBe('quarantined');
    expect(db.repository.snapshot(intent.jobId).blocked).toBe(1);
    db.repository.close();
  });

  it('recovers a crash after moving corrupt output into quarantine but before marking SQLite', async () => {
    const f = await fixture();
    const db = persisted(f);
    const intent = db.repository.beginPublicationIntent(f.intent);
    await publishStagedDirectory(intent, f.manifest, f.review);
    await writeFile(join(f.destinationPath, 'variant-2.png'), 'corrupt');
    const path = await quarantineCommittedDirectory(intent);
    db.repository.close();
    const reopened = new JobRepository(db.path);
    expect(await reconcilePendingPublications(reopened)).toEqual([{ transactionKey: intent.transactionKey, result: 'quarantined' }]);
    expect(await readFile(join(path, 'variant-2.png'), 'utf8')).toBe('corrupt');
    expect(reopened.getPublicationIntent(intent.jobId, intent.assetId, 1)?.state).toBe('quarantined');
    reopened.close();
  });

  it('publishes and marks SQLite complete only after the verified rename', async () => {
    const f = await fixture();
    const db = persisted(f);
    await publishReviewedAsset(db.repository, f.intent, f.manifest, f.review);
    expect(db.repository.snapshot(f.intent.jobId)).toMatchObject({ complete: 1 });
    expect(db.repository.listPublications(f.intent.jobId)).toHaveLength(1);
    expect(await inspectCommittedDirectory(f.intent)).toBe('valid');
    db.repository.close();
  });

  it('persists used review sessions and rejects reuse across restart', async () => {
    const f = await fixture();
    const db = persisted(f);
    const used = f.review.decision.sessionId;
    expect(db.repository.getUsedReviewSessionIds()).toEqual(new Set([used]));
    db.repository.close();
    const reopened = new JobRepository(db.path);
    expect(reopened.getUsedReviewSessionIds()).toEqual(new Set([used]));
    const second = structuredClone(readFixture<import('@ne-psd/contracts').JobSpec>('job.interactive.json'));
    second.jobId = 'job-2';
    reopened.createJob(second, null, { rootId: second.outputRootId, canonicalRoot: f.root,
      canonicalRootIdentity: f.intent.outputRootIdentity });
    reopened.transition(second.jobId, second.assets[0]!.assetId, 'rendering');
    reopened.transition(second.jobId, second.assets[0]!.assetId, 'reviewing');
    expect(() => reopened.recordReview({ reviewId: 'review-2', jobId: second.jobId, assetId: second.assets[0]!.assetId,
      attempt: 1, payload: { sessionId: used } })).toThrow(/session|reuse/i);
    reopened.close();
  });
});
