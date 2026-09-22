import { describe, expect, it } from 'vitest';
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
  it('migrates, reopens, snapshots from rows, and increments event sequence per job', async () => {
    const db = join(await mkdtemp(join(tmpdir(), 'ne-psd-db-')), 'state.sqlite');
    const first = new JobRepository(db);
    first.createJob(spec());
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
});
