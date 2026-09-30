import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { JobRepository } from '@ne-psd/core';
import type { JobSpec } from '@ne-psd/contracts';
import { readFixture } from '../fixtures/read-fixture.js';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'ne-psd-v2-attempt-'));
  const output = join(directory, 'output');
  await mkdir(output);
  const canonicalRoot = await realpath(output);
  const info = await stat(canonicalRoot);
  const binding = { rootId: 'fixture-output', canonicalRoot, canonicalRootIdentity: createHash('sha256').update(`${canonicalRoot}|${info.dev}|${info.ino}`).digest('hex') };
  const dbPath = join(directory, 'state.sqlite');
  const repository = new JobRepository(dbPath);
  const job = readFixture<JobSpec>('job.interactive.json');
  repository.recordQualification({ qualificationId: job.profile.qualificationId, profileId: job.profile.profileId, profileSha256: job.profile.profileSha256, profile: job.profile, evidence: {} });
  repository.createJob(job, null, binding);
  onTestFinished(async () => { if (repository.db.open) repository.close(); await rm(directory, { recursive: true, force: true }); });
  return { repository, dbPath, job, asset: job.assets[0]! };
}

describe('v2 attempt intent', () => {
  it('persists operation identity before dispatch and blocks replay after reopening', async () => {
    const f = await fixture();
    const operationId = 'operation-1';
    f.repository.beginV2Attempt(f.job.jobId, f.asset.assetId, 1, {
      installationId: 'photoshop-install-1', operationId, stagingDirectory: '/tmp/staging', sourceRootIdentity: 'a'.repeat(64),
    });
    expect(f.repository.pendingMutations('photoshop-install-1')).toMatchObject([{ operationId, attempt: 1, schemaVersion: 2 }]);
    f.repository.close();
    const reopened = new JobRepository(f.dbPath);
    expect(reopened.pendingMutations('photoshop-install-1')).toMatchObject([{ operationId, attempt: 1, schemaVersion: 2 }]);
    expect(() => reopened.beginV2Attempt(f.job.jobId, f.asset.assetId, 1, {
      installationId: 'photoshop-install-1', operationId: 'replay', stagingDirectory: '/tmp/new', sourceRootIdentity: 'a'.repeat(64),
    })).toThrow();
    reopened.markV2Safe(f.job.jobId, f.asset.assetId, 1, operationId);
    expect(reopened.pendingMutations('photoshop-install-1')).toEqual([]);
    reopened.close();
  });

  it('treats an in-flight legacy attempt as unresolved for every installation', async () => {
    const f = await fixture();
    f.repository.transition(f.job.jobId, f.asset.assetId, 'rendering');
    expect(f.repository.pendingMutations('another-installation')).toMatchObject([{ schemaVersion: 1, attempt: 1 }]);
  });
});
