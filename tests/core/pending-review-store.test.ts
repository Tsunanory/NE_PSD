import { mkdir, mkdtemp, realpath, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { EvidenceBundleManifest, JobSpec, RenderEvidenceV2, RenderRequestV2 } from '@ne-psd/contracts';
import type { ArtifactQaResult } from '../../packages/core/src/artifact-qa.js';
import { filesystemIdentity, JobRepository } from '../../packages/core/src/job-repository.js';
import { readFixture } from '../fixtures/read-fixture.js';

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ne-psd-pending-review-')));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const stagingDirectory = join(root, '.ne-psd-staging', 'job-1', 'asset-1', '1', 'operation-1');
  await mkdir(stagingDirectory, { recursive: true });
  const path = join(root, 'state.sqlite');
  const repository = new JobRepository(path);
  const job = structuredClone(readFixture<JobSpec>('job.interactive.json'));
  const request = structuredClone(readFixture<RenderRequestV2>('render-request.v2.valid.json'));
  const evidence = structuredClone(readFixture<RenderEvidenceV2>('render-evidence.v2.valid.json'));
  const manifest = structuredClone(readFixture<EvidenceBundleManifest>('manifest.pass.json'));
  job.assets[0]!.source.sha256 = evidence.sourceSha256;
  job.assets[0]!.sourceBytes = request.asset.sourceBytes;
  request.stagingDirectory = stagingDirectory;
  repository.recordQualification({ qualificationId: job.profile.qualificationId, profileId: job.profile.profileId,
    profileSha256: job.profile.profileSha256, profile: job.profile, evidence: { source: 'fixture' } });
  repository.createJob(job, null, { rootId: job.outputRootId, canonicalRoot: root, canonicalRootIdentity: filesystemIdentity(root) });
  repository.beginV2Attempt(job.jobId, job.assets[0]!.assetId, 1, { installationId: 'test-installation',
    operationId: request.operationId, stagingDirectory, sourceRootIdentity: 'a'.repeat(64) });
  repository.transition(job.jobId, job.assets[0]!.assetId, 'reviewing');
  const qa: ArtifactQaResult = {
    artifactChecksPassed: true,
    requirementResults: { 'BINDING.CURRENT_ATTEMPT': 'pass', 'ARTIFACTS.EXACTLY_THREE': 'pass', 'IMAGE.DECODE_FORMAT': 'pass',
      'IMAGE.DIMENSIONS_COLOR': 'pass', 'GEOMETRY.REQUESTED_FIT': 'pass', 'CLIPPING.ALPHA_ADJACENCY': 'pass',
      'VARIANTS.VISIBILITY': 'pass', 'EVIDENCE.TRACE_COMPLETE': 'pass', 'IMAGE.QUALITY': 'pass' },
    artifacts: evidence.artifacts.map((item) => ({ variantId: item.variantId, path: item.path, sha256: item.sha256,
      bytes: item.bytes, pixelSha256: 'a'.repeat(64), pixelBytes: 100, width: item.width, height: item.height,
      format: item.format, hasAlpha: false, firstPixelMatchFraction: 0, opaquePixelFraction: 1 })),
    diagnostics: [],
    bindings: { jobId: job.jobId, assetId: job.assets[0]!.assetId, attempt: 1,
      profileSha256: job.profile.profileSha256, sourceSha256: evidence.sourceSha256,
      toolSchemaSha256: job.profile.toolSchemaSha256, reviewPolicySha256: job.reviewPolicySha256 },
  };
  const pending = { jobId: job.jobId, assetId: job.assets[0]!.assetId, attempt: 1 as const,
    stagingDirectory, request, evidence, manifest, qa, reviewPolicySha256: job.reviewPolicySha256,
    plannerProfileSha256: 'a'.repeat(64), reviewerProfileSha256: 'b'.repeat(64) };
  return { repository, path, job, pending };
}

describe('durable pending review', () => {
  it('retains exact request, evidence, manifest and QA through database reopen', async () => {
    const f = await fixture();
    f.repository.savePendingReview(f.pending);
    f.repository.close();
    const reopened = new JobRepository(f.path);
    expect(reopened.getPendingReview(f.pending.jobId, f.pending.assetId, 1)).toEqual(f.pending);
    expect(reopened.listPendingReviews()).toEqual([f.pending]);
    expect(() => reopened.clearPendingReview(f.pending.jobId, f.pending.assetId, 1)).toThrow(/active|terminal/i);
    reopened.transition(f.pending.jobId, f.pending.assetId, 'blocked');
    reopened.clearPendingReview(f.pending.jobId, f.pending.assetId, 1);
    expect(reopened.listPendingReviews()).toEqual([]);
    reopened.close();
  });

  it('rejects conflicting replay and stale current attempt', async () => {
    const f = await fixture();
    f.repository.savePendingReview(f.pending);
    expect(() => f.repository.savePendingReview({ ...f.pending, reviewerProfileSha256: 'c'.repeat(64) })).toThrow();
    f.repository.transition(f.pending.jobId, f.pending.assetId, 'failed');
    f.repository.transition(f.pending.jobId, f.pending.assetId, 'queued');
    f.repository.transition(f.pending.jobId, f.pending.assetId, 'rendering');
    expect(() => f.repository.savePendingReview(f.pending)).toThrow(/stale|attempt/i);
    f.repository.close();
  });

  it('rejects pending review after selected model binding drifts', async () => {
    const f = await fixture();
    f.repository.savePendingReview(f.pending);
    f.repository.db.prepare('UPDATE jobs SET spec_json=? WHERE job_id=?').run(
      JSON.stringify({ ...f.job, reviewerModelProfileId: 'changed-reviewer' }), f.job.jobId);
    expect(() => f.repository.getPendingReview(f.pending.jobId, f.pending.assetId, 1)).toThrow(/binding|model/i);
    f.repository.close();
  });

  it('rejects a replaced staged directory on resume', async () => {
    const f = await fixture();
    f.repository.savePendingReview(f.pending);
    await rename(f.pending.stagingDirectory, `${f.pending.stagingDirectory}.saved`);
    await symlink(f.job.profile.template.relativePath, f.pending.stagingDirectory);
    expect(() => f.repository.getPendingReview(f.pending.jobId, f.pending.assetId, 1)).toThrow(/staging|binding|root/i);
    f.repository.close();
  });
});
