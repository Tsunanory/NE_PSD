import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { sha256Json, type HumanVisualAttestationV1, type JobSpec, type VisualReviewRequest } from '@ne-psd/contracts';
import { filesystemIdentity, JobRepository } from '../../packages/core/src/job-repository.js';
import { readFixture } from '../fixtures/read-fixture.js';

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ne-psd-visual-store-')));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'state.sqlite');
  const repository = new JobRepository(path);
  const job = structuredClone(readFixture<JobSpec>('job.interactive.json'));
  repository.recordQualification({ qualificationId: job.profile.qualificationId, profileId: job.profile.profileId,
    profileSha256: job.profile.profileSha256, profile: job.profile, evidence: { source: 'fixture' } });
  repository.createJob(job, null, { rootId: job.outputRootId, canonicalRoot: root, canonicalRootIdentity: filesystemIdentity(root) });
  repository.transition(job.jobId, job.assets[0]!.assetId, 'rendering');
  repository.transition(job.jobId, job.assets[0]!.assetId, 'reviewing');
  const request = structuredClone(readFixture<VisualReviewRequest>('visual-review-request.json'));
  request.sourceSha256 = job.assets[0]!.source.sha256;
  const context = { plannerProfileSha256: 'a'.repeat(64), reviewerProfileSha256: 'b'.repeat(64), expiresAt: '2099-01-01T00:00:00.000Z' };
  const attestation: HumanVisualAttestationV1 = { schemaVersion: 1, request, decision: 'approve',
    notes: 'Three outputs inspected', operatorIdentity: 'trusted-main/operator-1',
    consumedAt: new Date().toISOString(), expiresAt: context.expiresAt };
  const file = { relativePath: 'attestations/asset-1.json', sha256: sha256Json(attestation) };
  return { repository, path, job, request, context, attestation, file };
}

describe('durable visual attestation requests', () => {
  it('persists one current request and an exactly-once trusted receipt across reopen', async () => {
    const f = await fixture();
    f.repository.createVisualReviewRequest(f.request, f.context);
    expect(f.repository.getCurrentVisualReviewRequest(f.job.jobId, f.request.assetId)).toEqual(f.request);
    expect(f.repository.getVisualReviewRequestBinding(f.request.requestId)).toEqual({
      plannerModelProfileId: f.job.modelProfileId, reviewerModelProfileId: f.job.reviewerModelProfileId,
      plannerProfileSha256: f.context.plannerProfileSha256, reviewerProfileSha256: f.context.reviewerProfileSha256,
      expiresAt: f.context.expiresAt,
    });
    const first = f.repository.consumeVisualReviewRequest(f.attestation, f.file);
    f.repository.close();
    const reopened = new JobRepository(f.path);
    expect(reopened.getVisualReviewRequest(f.request.requestId)).toEqual(f.request);
    expect(reopened.consumeVisualReviewRequest(f.attestation, f.file)).toEqual(first);
    expect(reopened.getConsumedVisualAttestation(f.job.jobId, f.request.assetId, 1)).toEqual(first);
    expect(first).toMatchObject({ request: f.request, decision: 'approve', operatorIdentity: 'trusted-main/operator-1',
      consumed: true, attestationRelativePath: f.file.relativePath, attestationSha256: f.file.sha256 });
    reopened.close();
  });

  it('rejects conflicting request and conflicting attestation replay', async () => {
    const f = await fixture();
    f.repository.createVisualReviewRequest(f.request, f.context);
    expect(() => f.repository.createVisualReviewRequest({ ...f.request, requestId: 'other-request' }, f.context)).toThrow();
    f.repository.consumeVisualReviewRequest(f.attestation, f.file);
    expect(() => f.repository.consumeVisualReviewRequest({ ...f.attestation, decision: 'reject' }, f.file)).toThrow();
    f.repository.close();
  });

  it('rejects an expired or stale request after the asset advances', async () => {
    const f = await fixture();
    f.repository.createVisualReviewRequest(f.request, { ...f.context, expiresAt: '2020-01-01T00:00:00.000Z' });
    expect(() => f.repository.consumeVisualReviewRequest({ ...f.attestation, expiresAt: '2020-01-01T00:00:00.000Z' }, f.file)).toThrow();
    f.repository.transition(f.job.jobId, f.request.assetId, 'failed');
    f.repository.transition(f.job.jobId, f.request.assetId, 'queued');
    f.repository.transition(f.job.jobId, f.request.assetId, 'rendering');
    expect(() => f.repository.consumeVisualReviewRequest(f.attestation, f.file)).toThrow();
    f.repository.close();
  });
});
