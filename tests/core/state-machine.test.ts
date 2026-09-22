import { describe, expect, it } from 'vitest';
import { sha256Json } from '@ne-psd/contracts';
import { assertAssetTransition, JobRepository, StateMachineError } from '@ne-psd/core';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assignAssetIds } from '@ne-psd/core';

describe('state machine', () => {
  it('rejects publishing before review and allows only bounded transitions', () => {
    expect(() => assertAssetTransition('rendering', 'complete')).toThrowError(StateMachineError);
    expect(() => assertAssetTransition('reviewing', 'readyToCommit')).not.toThrow();
    expect(() => assertAssetTransition('complete', 'rendering')).toThrowError(StateMachineError);
  });

  it('retry creates a successor job with selected failed assets and preserves the prior job', async () => {
    const db = join(await mkdtemp(join(tmpdir(), 'ne-psd-retry-')), 'state.sqlite');
    const repository = new JobRepository(db);
    const hash = 'a'.repeat(64);
    const selector = { documentRoute: [], layerPath: [{ name: 'target', kind: 'smartObject' as const, fingerprint: 'f' }] };
    const job = { schemaVersion: 1, jobId: 'job-1', outputRootId: 'out', modelProfileId: 'brain', reviewerModelProfileId: 'reviewer', reviewPolicySha256: hash, trigger: 'interactive' as const, maxAttempts: 2 as const, profile: { schemaVersion: 1 as const, profileId: 'profile', template: { rootId: 'templates', relativePath: 'template.psd', sha256: hash }, profileSha256: hash, qualificationId: 'qualification', backendId: 'alisaitteke' as const, toolSchemaSha256: hash, targets: [{ target: selector, reference: selector, input: null }], fitMode: 'cover' as const, output: { format: 'png' as const, quality: 90, colorSpace: 'sRGB' as const, width: 10, height: 10 }, variants: [{ id: '1' as const, group: selector }, { id: '2' as const, group: { ...selector, layerPath: [{ ...selector.layerPath[0]!, name: 'v2' }] } }, { id: '3' as const, group: { ...selector, layerPath: [{ ...selector.layerPath[0]!, name: 'v3' }] } }] }, assets: [{ assetId: 'asset-1', source: { rootId: 'input', relativePath: 'a.png', sha256: hash }, sourceBytes: 1 }] };
    job.profile.profileSha256 = sha256Json(job.profile, { excludeKeys: ['profileSha256'] });
    repository.recordQualification({ qualificationId: 'qualification', profileId: 'profile', profileSha256: job.profile.profileSha256, evidence: { source: 'test' }, profile: job.profile }); repository.createJob(job);
    repository.transition('job-1', 'asset-1', 'rendering');
    repository.transition('job-1', 'asset-1', 'failed', { code: 'FAILED', category: 'transient', message: 'failed', retryable: true, evidencePaths: [] });
    const successor = repository.retryFailed('job-1');
    expect(successor.jobId).not.toBe('job-1');
    expect(repository.snapshot('job-1').failed).toBe(1);
    expect(repository.snapshot(successor.jobId).total).toBe(1);
    repository.close();
  });

  it('does not let retryFailed bypass a blocked review state', async () => {
    const db = join(await mkdtemp(join(tmpdir(), 'ne-psd-blocked-')), 'state.sqlite');
    const repository = new JobRepository(db);
    const hash = 'a'.repeat(64);
    const selector = { documentRoute: [], layerPath: [{ name: 'target', kind: 'smartObject' as const, fingerprint: 'f' }] };
    const blockedJob = { schemaVersion: 1, jobId: 'job-blocked', outputRootId: 'out', modelProfileId: 'brain', reviewerModelProfileId: 'reviewer', reviewPolicySha256: hash, trigger: 'interactive' as const, maxAttempts: 2 as const, profile: { schemaVersion: 1 as const, profileId: 'profile', template: { rootId: 'templates', relativePath: 'template.psd', sha256: hash }, profileSha256: hash, qualificationId: 'qualification', backendId: 'alisaitteke' as const, toolSchemaSha256: hash, targets: [{ target: selector, reference: selector, input: null }], fitMode: 'cover' as const, output: { format: 'png' as const, quality: 90, colorSpace: 'sRGB' as const, width: 10, height: 10 }, variants: [{ id: '1' as const, group: selector }, { id: '2' as const, group: selector }, { id: '3' as const, group: selector }] }, assets: [{ assetId: 'asset-blocked', source: { rootId: 'input', relativePath: 'a.png', sha256: hash }, sourceBytes: 1 }] };
    blockedJob.profile.profileSha256 = sha256Json(blockedJob.profile, { excludeKeys: ['profileSha256'] });
    repository.recordQualification({ qualificationId: 'qualification', profileId: 'profile', profileSha256: blockedJob.profile.profileSha256, evidence: { source: 'test' }, profile: blockedJob.profile }); repository.createJob(blockedJob);
    repository.transition('job-blocked', 'asset-blocked', 'rendering');
    repository.transition('job-blocked', 'asset-blocked', 'blocked', { code: 'REVIEW_WAIT', category: 'review', message: 'review unavailable', retryable: false, evidencePaths: [] });
    expect(() => repository.retryFailed('job-blocked')).toThrowError(/failed assets/i);
    repository.close();
  });

  it('allocates IDs deterministically independent of input order and rejects duplicate full identities', () => {
    const entries = [{ relativePath: 'A/image.png', sha256: 'a'.repeat(64) }, { relativePath: 'B/image.png', sha256: 'b'.repeat(64) }];
    expect([...assignAssetIds(entries)]).toEqual([...assignAssetIds([...entries].reverse())]);
    expect(() => assignAssetIds([entries[0]!, entries[0]!])).toThrowError(/duplicate/i);
  });
});
