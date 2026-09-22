import { describe, expect, it } from 'vitest';
import { assertAssetTransition, JobRepository, StateMachineError } from '@ne-psd/core';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    repository.createJob({ schemaVersion: 1, jobId: 'job-1', outputRootId: 'out', modelProfileId: 'brain', reviewerModelProfileId: 'reviewer', reviewPolicySha256: hash, trigger: 'interactive', maxAttempts: 2, profile: { schemaVersion: 1, profileId: 'profile', template: { rootId: 'templates', relativePath: 'template.psd', sha256: hash }, profileSha256: hash, qualificationId: 'qualification', backendId: 'alisaitteke', toolSchemaSha256: hash, targets: [{ target: selector, reference: selector, input: null }], fitMode: 'cover', output: { format: 'png', quality: 90, colorSpace: 'sRGB', width: 10, height: 10 }, variants: [{ id: '1', group: selector }, { id: '2', group: { ...selector, layerPath: [{ ...selector.layerPath[0]!, name: 'v2' }] } }, { id: '3', group: { ...selector, layerPath: [{ ...selector.layerPath[0]!, name: 'v3' }] } }] }, assets: [{ assetId: 'asset-1', source: { rootId: 'input', relativePath: 'a.png', sha256: hash }, sourceBytes: 1 }] });
    repository.transition('asset-1', 'rendering');
    repository.transition('asset-1', 'failed', { code: 'FAILED', category: 'transient', message: 'failed', retryable: true, evidencePaths: [] });
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
    repository.createJob({ schemaVersion: 1, jobId: 'job-blocked', outputRootId: 'out', modelProfileId: 'brain', reviewerModelProfileId: 'reviewer', reviewPolicySha256: hash, trigger: 'interactive', maxAttempts: 2, profile: { schemaVersion: 1, profileId: 'profile', template: { rootId: 'templates', relativePath: 'template.psd', sha256: hash }, profileSha256: hash, qualificationId: 'qualification', backendId: 'alisaitteke', toolSchemaSha256: hash, targets: [{ target: selector, reference: selector, input: null }], fitMode: 'cover', output: { format: 'png', quality: 90, colorSpace: 'sRGB', width: 10, height: 10 }, variants: [{ id: '1', group: selector }, { id: '2', group: { ...selector, layerPath: [{ ...selector.layerPath[0]!, name: 'v2' }] } }, { id: '3', group: { ...selector, layerPath: [{ ...selector.layerPath[0]!, name: 'v3' }] } }] }, assets: [{ assetId: 'asset-blocked', source: { rootId: 'input', relativePath: 'a.png', sha256: hash }, sourceBytes: 1 }] });
    repository.transition('asset-blocked', 'rendering');
    repository.transition('asset-blocked', 'blocked', { code: 'REVIEW_WAIT', category: 'review', message: 'review unavailable', retryable: false, evidencePaths: [] });
    expect(() => repository.retryFailed('job-blocked')).toThrowError(/failed assets/i);
    repository.close();
  });
});
