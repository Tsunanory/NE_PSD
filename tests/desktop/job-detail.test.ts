import { describe, expect, it } from 'vitest';
import { loadFixture } from '@ne-psd/contracts/testing';
import type { EvidenceBundleManifest, JobSpec, ReviewDecision } from '@ne-psd/contracts';
import { FakeJobService } from '../../apps/desktop/src/main/services.js';
import { readAssetDetail, type JobDetailAdapter } from '../../apps/desktop/src/main/job-detail.js';

async function fixture() {
  const jobs = new FakeJobService();
  await jobs.start(loadFixture<JobSpec>('job.interactive.json'));
  const review = loadFixture<ReviewDecision>('review.pass.json');
  const manifest = loadFixture<EvidenceBundleManifest>('manifest.pass.json');
  const id = manifest.files.find((file) => file.relativePath === 'assets/variant-1.jpg')!.sha256;
  const adapter: JobDetailAdapter = { assetAttempts: async () => [{ review, manifest,
    diagnostics: [{ evidenceId: id, code: 'VISUAL_CHECK', summary: 'Source /private/secret/image.jpg failed' }] }] };
  return { jobs, adapter, id };
}

describe('trusted asset detail projection', () => {
  it('reports unavailable without a trusted adapter and rejects an unknown asset', async () => {
    const { jobs } = await fixture();
    await expect(readAssetDetail(jobs, undefined, 'job-1', 'asset-1', false)).resolves.toEqual({ available: false, synthetic: false, attempts: [] });
    await expect(readAssetDetail(jobs, undefined, 'job-1', 'missing', false)).rejects.toThrow('outside job snapshot');
  });

  it('projects real fixture verdicts and manifest digests without paths', async () => {
    const { jobs, adapter, id } = await fixture();
    const detail = await readAssetDetail(jobs, adapter, 'job-1', 'asset-1', true);
    expect(detail.available).toBe(true);
    expect(detail.synthetic).toBe(true);
    expect(detail.attempts[0]?.verdict).toBe('pass');
    expect(detail.attempts[0]?.variants).toHaveLength(3);
    expect(detail.attempts[0]?.checks[0]).toMatchObject({ requirementId: 'BINDING.CURRENT_ATTEMPT', result: 'pass' });
    expect(detail.attempts[0]?.variants[0]?.evidenceIds).toContain(id);
    expect(detail.attempts[0]?.diagnostics[0]?.summary).toContain('[path]');
    expect(JSON.stringify(detail)).not.toContain('assets/variant-1.jpg');
    expect(JSON.stringify(detail)).not.toContain('/private/secret');
  });

  it('rejects mismatched review identity and diagnostics absent from the manifest', async () => {
    const { jobs, adapter } = await fixture();
    const bad = await adapter.assetAttempts('job-1', 'asset-1');
    await expect(readAssetDetail(jobs, { assetAttempts: async () => [{ ...bad[0]!, review: { ...bad[0]!.review, assetId: 'other' } }] }, 'job-1', 'asset-1', false)).rejects.toThrow('outside current job attempt');
    await expect(readAssetDetail(jobs, { assetAttempts: async () => [{ ...bad[0]!, diagnostics: [{ evidenceId: 'f'.repeat(64), code: 'BAD', summary: 'bad' }] }] }, 'job-1', 'asset-1', false)).rejects.toThrow('not bound');
  });
});
