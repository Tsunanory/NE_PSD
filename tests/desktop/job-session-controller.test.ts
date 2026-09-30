import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { EvidenceBundleManifest, JobService, JobSnapshot, VisualReviewRequest } from '@ne-psd/contracts';
import { JobSessionController, type JobEvidenceAdapter } from '../../apps/desktop/src/main/job-session-controller.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pWQAAAAASUVORK5CYII=', 'base64');
const digest = createHash('sha256').update(png).digest('hex');
const snapshot = (jobId: string, state: JobSnapshot['state'] = 'running'): JobSnapshot => ({ jobId, state, total: 1, complete: 0, failed: 0, blocked: 0, assets: [{ assetId: 'asset-1', status: 'reviewing', attempt: 1, error: null }] });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ne-psd-session-'));
  mkdirSync(join(root, 'images'));
  for (const name of ['1.png', '2.png', '3.png', 'contact.png']) writeFileSync(join(root, 'images', name), png);
  const artifacts = (['1', '2', '3'] as const).map((variantId) => ({ variantId, path: `images/${variantId}.png`, sha256: digest, bytes: png.length, width: 1, height: 1, format: 'png' as const, colorSpace: 'sRGB' as const })) as VisualReviewRequest['artifacts'];
  const request: VisualReviewRequest = { requestId: 'request-1', jobId: 'job-1', assetId: 'asset-1', attempt: 1, preAttestationContentSha256: 'a'.repeat(64), profileSha256: 'b'.repeat(64), sourceSha256: 'c'.repeat(64), toolSchemaSha256: 'd'.repeat(64), reviewPolicySha256: 'e'.repeat(64), artifacts, contactSheet: { relativePath: 'images/contact.png', sha256: digest } };
  const manifest: EvidenceBundleManifest = { schemaVersion: 1, jobId: 'job-1', assetId: 'asset-1', attempt: 1,
    files: [...artifacts.map((artifact) => ({ relativePath: artifact.path, sha256: digest, bytes: png.length, role: 'artifact' as const })), { relativePath: 'images/contact.png', sha256: digest, bytes: png.length, role: 'imageInput' as const }],
    visionInputs: artifacts.map((artifact) => ({ id: artifact.variantId, role: 'output' as const, relativePath: artifact.path, sha256: digest, width: 1, height: 1, variantId: artifact.variantId, derivedFromSha256: digest, crop: null })) };
  const jobs = { snapshot: vi.fn(async (jobId: string) => snapshot(jobId)), pause: vi.fn(async () => undefined), visualReview: vi.fn(async () => request) } as unknown as JobService;
  const adapter: JobEvidenceAdapter = { reviewImages: vi.fn(async () => ({ root, manifest })), committedOutput: vi.fn(async () => ({ root, record: { jobId: 'job-1', assetId: 'asset-1', relativePath: 'images/1.png', sha256: digest, bytes: png.length, state: 'complete' } })) };
  return { root, request, manifest, jobs, adapter };
}

describe('durable desktop job session', () => {
  it('records bounded job IDs atomically and rehydrates actual snapshots after restart', async () => {
    const { root, jobs } = fixture();
    const session = new JobSessionController({ jobs, userDataDirectory: root, developmentFake: true });
    for (let index = 0; index < 22; index++) await session.recordStarted(`job-${index}`);
    const saved = JSON.parse(await readFile(join(root, 'recent-jobs.json'), 'utf8'));
    expect(saved.jobIds).toHaveLength(20);
    expect(saved.jobIds[0]).toBe('job-21');
    const restored = new JobSessionController({ jobs, userDataDirectory: root, developmentFake: true });
    expect((await restored.recentJobs())[0]?.snapshot.jobId).toBe('job-21');
    expect(jobs.snapshot).toHaveBeenCalled();
  });
  it('fails closed without an evidence source and rejects stale manifest or output digest', async () => {
    const { root, jobs, adapter, manifest } = fixture();
    const missing = new JobSessionController({ jobs, userDataDirectory: root, developmentFake: false });
    await expect(missing.readReviewImages('job-1', 'asset-1')).rejects.toThrow('adapter unavailable');
    await expect(missing.committedOutput('job-1', 'asset-1')).rejects.toThrow('adapter unavailable');
    const session = new JobSessionController({ jobs, userDataDirectory: root, developmentFake: false, evidenceAdapter: adapter });
    expect((await session.readReviewImages('job-1', 'asset-1')).variants).toHaveLength(3);
    await expect(session.committedOutput('job-1', 'asset-1')).resolves.toContain('images/1.png');
    vi.mocked(adapter.reviewImages).mockResolvedValue({ root, manifest: { ...manifest, attempt: 2 } });
    await expect(session.readReviewImages('job-1', 'asset-1')).rejects.toThrow('do not match');
    vi.mocked(adapter.committedOutput).mockResolvedValue({ root, record: { jobId: 'job-1', assetId: 'asset-1', relativePath: 'images/1.png', sha256: 'f'.repeat(64), bytes: png.length, state: 'complete' } });
    await expect(session.committedOutput('job-1', 'asset-1')).rejects.toThrow('digest mismatch');
  });
  it('pauses every active job and blocks close on pause errors', async () => {
    const { root, jobs } = fixture();
    const states = new Map([['job-1', 'running'], ['job-2', 'running']]);
    vi.mocked(jobs.snapshot).mockImplementation(async (id) => snapshot(id, states.get(id) as JobSnapshot['state']));
    vi.mocked(jobs.pause).mockImplementation(async (id) => { states.set(id, 'paused'); });
    const session = new JobSessionController({ jobs, userDataDirectory: root, developmentFake: true });
    await session.recordStarted('job-1'); await session.recordStarted('job-2');
    await session.safeClose();
    expect(jobs.pause).toHaveBeenCalledTimes(2);
    states.set('job-1', 'running');
    vi.mocked(jobs.pause).mockRejectedValue(new Error('persistence failure'));
    await expect(session.safeClose()).rejects.toThrow('persistence failure');
  });
});
