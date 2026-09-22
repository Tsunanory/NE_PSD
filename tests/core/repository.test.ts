import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobRepository } from '@ne-psd/core';
import type { JobSpec } from '@ne-psd/contracts';

const hash = 'a'.repeat(64);
const selector = { documentRoute: [], layerPath: [{ name: 'target', kind: 'smartObject' as const, fingerprint: 'f' }] };
const spec = (jobId = 'job-1'): JobSpec => ({
  schemaVersion: 1, jobId, outputRootId: 'out', modelProfileId: 'brain', reviewerModelProfileId: 'reviewer', reviewPolicySha256: hash,
  trigger: 'interactive', maxAttempts: 2,
  profile: { schemaVersion: 1, profileId: 'profile', template: { rootId: 'templates', relativePath: 'template.psd', sha256: hash }, profileSha256: hash, qualificationId: 'qualification', backendId: 'alisaitteke', toolSchemaSha256: hash, targets: [{ target: selector, reference: selector, input: null }], fitMode: 'cover', output: { format: 'png', quality: 90, colorSpace: 'sRGB', width: 10, height: 10 }, variants: [{ id: '1', group: selector }, { id: '2', group: { ...selector, layerPath: [{ ...selector.layerPath[0]!, name: 'v2' }] } }, { id: '3', group: { ...selector, layerPath: [{ ...selector.layerPath[0]!, name: 'v3' }] } }] },
  assets: [{ assetId: 'asset-1', source: { rootId: 'input', relativePath: 'a.png', sha256: hash }, sourceBytes: 1 }],
});

describe('durable repository', () => {
  const createQualified = (repository: JobRepository, value: JobSpec) => { repository.recordQualification({ qualificationId: value.profile.qualificationId, profileId: value.profile.profileId, profileSha256: value.profile.profileSha256, evidence: { source: 'test' } }); repository.createJob(value); };
  it('migrates, reopens, snapshots from rows, and increments event sequence per job', async () => {
    expect(existsSync(join(process.cwd(), 'packages/core/dist/migrations/001-initial.sql'))).toBe(true);
    const db = join(await mkdtemp(join(tmpdir(), 'ne-psd-db-')), 'state.sqlite');
    const first = new JobRepository(db);
    createQualified(first, spec());
    first.transition('asset-1', 'rendering');
    const event = first.appendEvent('job-1', 'assetStatus');
    expect(event.sequence).toBe(1);
    expect(first.snapshot('job-1').assets[0]!.status).toBe('rendering');
    first.close();
    const reopened = new JobRepository(db);
    expect(reopened.snapshot('job-1').assets[0]!.status).toBe('rendering');
    expect(reopened.snapshot('job-1').complete).toBe(0);
    expect(reopened.appendEvent('job-1', 'snapshot').sequence).toBe(2);
    reopened.close();
  });

  it('persists attempts, reviews, publications, and qualifications with transaction uniqueness', async () => {
    const db = join(await mkdtemp(join(tmpdir(), 'ne-psd-records-')), 'state.sqlite');
    const repository = new JobRepository(db);
    createQualified(repository, spec('records'));
    repository.transition('asset-1', 'rendering');
    expect(repository.attempts('records', 'asset-1')).toHaveLength(1);
    repository.recordReview({ reviewId: 'review-1', jobId: 'records', assetId: 'asset-1', attempt: 1, payload: { verdict: 'blocked' } });
    repository.recordPublication({ publicationId: 'publication-1', jobId: 'records', assetId: 'asset-1', attempt: 1, transactionKey: 'tx-1', path: '/tmp/published' });
    repository.recordQualification({ qualificationId: 'qualification-1', profileId: 'profile-2', profileSha256: 'b'.repeat(64), evidence: { path: 'evidence' } });
    expect(repository.getQualification('qualification-1')?.profileSha256).toBe('b'.repeat(64));
    expect(() => repository.recordPublication({ publicationId: 'publication-2', jobId: 'records', assetId: 'asset-1', attempt: 1, transactionKey: 'tx-1', path: '/tmp/other' })).toThrow();
    repository.close();
  });

  it('keeps pause and cancel requests pending until safe-boundary acknowledgement', async () => {
    const db = join(await mkdtemp(join(tmpdir(), 'ne-psd-control-')), 'state.sqlite');
    const repository = new JobRepository(db);
    createQualified(repository, spec('control'));
    repository.transition('asset-1', 'rendering');
    repository.pause('control');
    expect(repository.controlState('control')).toBe('pause');
    repository.transition('asset-1', 'reviewing');
    expect(repository.snapshot('control').assets[0]!.status).toBe('reviewing');
    repository.acknowledgePause('control');
    expect(repository.snapshot('control').state).toBe('paused');
    repository.requestCancel('control');
    expect(repository.controlState('control')).toBe('cancel');
    repository.acknowledgeCancel('control');
    expect(repository.snapshot('control').assets[0]!.status).toBe('cancelled');
    repository.close();
  });

  it('uses failed then blocked precedence for mixed terminal assets', async () => {
    const db = join(await mkdtemp(join(tmpdir(), 'ne-psd-precedence-')), 'state.sqlite');
    const repository = new JobRepository(db);
    const job = spec('precedence');
    job.assets = [job.assets[0]!, { ...job.assets[0]!, assetId: 'asset-2', source: { ...job.assets[0]!.source, relativePath: 'b.png' } }];
    createQualified(repository, job);
    repository.transition('asset-1', 'rendering'); repository.transition('asset-1', 'failed', { code: 'FAILED', category: 'transient', message: 'failed', retryable: true, evidencePaths: [] });
    repository.transition('asset-2', 'rendering'); repository.transition('asset-2', 'blocked', { code: 'BLOCKED', category: 'review', message: 'blocked', retryable: false, evidencePaths: [] });
    expect(repository.snapshot('precedence').state).toBe('blocked');
    repository.close();
  });

  it('does not expose ready for complete plus failed terminal assets', async () => {
    const db = join(await mkdtemp(join(tmpdir(), 'ne-psd-mixed-terminal-')), 'state.sqlite');
    const repository = new JobRepository(db);
    const job = spec('mixed-terminal');
    job.assets = [job.assets[0]!, { ...job.assets[0]!, assetId: 'asset-2', source: { ...job.assets[0]!.source, relativePath: 'b.png' } }];
    createQualified(repository, job);
    repository.transition('asset-1', 'rendering'); repository.transition('asset-1', 'reviewing'); repository.transition('asset-1', 'readyToCommit'); repository.transition('asset-1', 'complete');
    repository.transition('asset-2', 'rendering'); repository.transition('asset-2', 'failed', { code: 'FAILED', category: 'transient', message: 'failed', retryable: true, evidencePaths: [] });
    expect(repository.snapshot('mixed-terminal').state).toBe('failed');
    repository.close();
  });

  it('rejects a job whose template qualification lookup is missing', async () => {
    const db = join(await mkdtemp(join(tmpdir(), 'ne-psd-unqualified-')), 'state.sqlite');
    const repository = new JobRepository(db);
    expect(() => repository.createJob(spec('unqualified'))).toThrowError(/qualification/i);
    repository.close();
  });
});
