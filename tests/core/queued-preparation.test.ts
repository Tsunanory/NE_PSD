import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { type DomainError, type JobSpec } from '@ne-psd/contracts';
import { filesystemIdentity, JobRepository } from '../../packages/core/src/job-repository.js';
import { readFixture } from '../fixtures/read-fixture.js';

describe('pre-render preparation failure', () => {
  it('records failed asset without creating a Photoshop attempt', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'ne-psd-queued-fail-')));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const repository = new JobRepository(join(root, 'state.sqlite'));
    const job = structuredClone(readFixture<JobSpec>('job.interactive.json'));
    repository.recordQualification({ qualificationId: job.profile.qualificationId, profileId: job.profile.profileId,
      profileSha256: job.profile.profileSha256, profile: job.profile, evidence: { source: 'fixture' } });
    repository.createJob(job, null, { rootId: job.outputRootId, canonicalRoot: root, canonicalRootIdentity: filesystemIdentity(root) });
    const error: DomainError = { code: 'PREPARE_FAILED', category: 'validation',
      message: 'owned copy failed', retryable: false, evidencePaths: [] };
    repository.failQueuedAsset(job.jobId, job.assets[0]!.assetId, error);
    expect(repository.snapshot(job.jobId)).toMatchObject({ state: 'failed', failed: 1,
      assets: [{ status: 'failed', attempt: 0, error }] });
    expect(repository.attempts(job.jobId, job.assets[0]!.assetId)).toEqual([]);
    expect(() => repository.failQueuedAsset(job.jobId, job.assets[0]!.assetId, error)).toThrow(/queued/i);
    repository.close();
  });
});
