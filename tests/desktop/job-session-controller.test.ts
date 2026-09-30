import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { EvidenceBundleManifest, JobService, JobSnapshot, VisualReviewRequest } from '@ne-psd/contracts';
import { JobSessionController, type JobEvidenceAdapter } from '../../apps/desktop/src/main/job-session-controller.js';
import { FakeJobService, createFakeJobEvidenceAdapter } from '../../apps/desktop/src/main/fake-job-service.js';
import { loadFixture } from '@ne-psd/contracts/testing';
import type { JobSpec } from '@ne-psd/contracts';

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
  it('binds explicit synthetic fake review to real fixture bytes and all three variants', async () => {
    const fake = new FakeJobService();
    const spec = loadFixture<JobSpec>('job.interactive.json');
    const { jobId } = await fake.start(spec);
    const assetId = spec.assets[0]!.assetId;
    const session = new JobSessionController({ jobs: fake, userDataDirectory: mkdtempSync(join(tmpdir(), 'ne-psd-fake-session-')), developmentFake: true, evidenceAdapter: createFakeJobEvidenceAdapter() });
    const images = await session.readReviewImages(jobId, assetId);
    expect(images.synthetic).toBe(true);
    expect(images.variants.map((item) => item.variantId)).toEqual(['1', '2', '3']);
    expect(images.variants.every((item) => item.dataUrl.startsWith('data:image/jpeg;base64,'))).toBe(true);
    expect(images.contactSheet.dataUrl).toMatch(/^data:image\/png;base64,/);
    await expect(session.committedOutput(jobId, assetId)).rejects.toThrow('not committed');
  });
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
  it('refuses to close failed or ambiguous Photoshop state without trusted quiescence evidence', async () => {
    for (const state of ['failed', 'blocked'] as const) {
      const { root, jobs } = fixture();
      vi.mocked(jobs.snapshot).mockImplementation(async (id) => snapshot(id, state));
      const session = new JobSessionController({ jobs, userDataDirectory: root, developmentFake: true });
      await session.recordStarted(`${state}-job`);
      await expect(session.safeClose()).rejects.toThrow('recovery must be resolved');
      expect(jobs.pause).not.toHaveBeenCalled();
      expect((await session.recentJobs())[0]?.snapshot.state).toBe(state);
    }
  });
  it('atomically persists a trusted retry link and closes only after its successor pauses', async () => {
    const { root, jobs } = fixture();
    const states = new Map<string, JobSnapshot>([
      ['job-old', { ...snapshot('job-old', 'failed'), failed: 1, assets: [{ assetId: 'asset-1', status: 'failed', attempt: 1, error: { code: 'TRANSIENT', category: 'transient', message: 'retryable', retryable: true, evidencePaths: [] } }] }],
      ['job-next', { ...snapshot('job-next'), assets: [{ assetId: 'asset-1', status: 'queued', attempt: 2, error: null }] }],
    ]);
    vi.mocked(jobs.snapshot).mockImplementation(async (id) => states.get(id) ?? Promise.reject(new Error('unknown job')));
    vi.mocked(jobs.pause).mockImplementation(async (id) => { states.set(id, { ...states.get(id)!, state: 'paused' }); });
    const session = new JobSessionController({ jobs, userDataDirectory: root, developmentFake: false });
    await session.recordStarted('job-old');
    await session.recordRetry('job-old', 'job-next');
    const saved = JSON.parse(await readFile(join(root, 'recent-jobs.json'), 'utf8'));
    expect(saved).toMatchObject({ jobIds: ['job-next', 'job-old'], retryLinks: [{ from: 'job-old', to: 'job-next' }] });
    const restarted = new JobSessionController({ jobs, userDataDirectory: root, developmentFake: false });
    await expect(restarted.safeClose()).resolves.toBeUndefined();
    expect(jobs.pause).toHaveBeenCalledExactlyOnceWith('job-next');
    expect((await restarted.recentJobs()).map((entry) => entry.snapshot.state)).toEqual(['paused', 'failed']);
  });
  it('rejects missing, ambiguous, blocked, stale and cyclic retry recovery links', async () => {
    const { root, jobs } = fixture();
    const old = { ...snapshot('job-old', 'failed'), failed: 1, assets: [{ assetId: 'asset-1', status: 'failed' as const, attempt: 1, error: { code: 'TRANSIENT', category: 'transient' as const, message: 'retryable', retryable: true, evidencePaths: [] } }] };
    const next = { ...snapshot('job-next'), assets: [{ assetId: 'asset-1', status: 'queued' as const, attempt: 2, error: null }] };
    const states = new Map<string, JobSnapshot>([['job-old', old], ['job-next', next]]);
    vi.mocked(jobs.snapshot).mockImplementation(async (id) => states.get(id) ?? Promise.reject(new Error('unknown job')));
    const session = new JobSessionController({ jobs, userDataDirectory: root, developmentFake: false });
    await session.recordStarted('job-old');
    await expect(session.safeClose()).rejects.toThrow('recovery must be resolved');
    await expect(session.recordRetry('job-old', 'missing')).rejects.toThrow('unknown job');
    states.set('job-old', { ...old, assets: [{ ...old.assets[0]!, error: { ...old.assets[0]!.error!, category: 'ambiguousState' } }] });
    await expect(session.recordRetry('job-old', 'job-next')).rejects.toThrow('not safe');
    states.set('job-old', old);
    states.set('job-next', { ...next, state: 'blocked' });
    await expect(session.recordRetry('job-old', 'job-next')).rejects.toThrow('not safe');
    states.set('job-next', next);
    await session.recordRetry('job-old', 'job-next');
    states.set('job-next', { ...next, state: 'blocked' });
    await expect(session.safeClose()).rejects.toThrow('recovery must be resolved');
    states.set('job-next', { ...next, state: 'paused' });
    await expect(session.safeClose()).resolves.toBeUndefined();
    states.set('job-next', { ...next, state: 'paused', assets: [{ ...next.assets[0]!, attempt: 1 }] });
    await expect(session.safeClose()).rejects.toThrow('retry successor is not safely paused');
    states.set('job-next', { ...next, state: 'paused', assets: [{ ...next.assets[0]!, error: { code: 'AMBIGUOUS', category: 'ambiguousState', message: 'state unknown', retryable: false, evidencePaths: [] } }] });
    await expect(session.safeClose()).rejects.toThrow('ambiguous job state');
    states.set('job-next', { ...next, state: 'paused' });
    await expect(session.recordRetry('job-old', 'job-next')).rejects.toThrow('stale or conflicting');
    await writeFile(join(root, 'recent-jobs.json'), JSON.stringify({ schemaVersion: 1, jobIds: ['job-next', 'job-old'], retryLinks: [{ from: 'job-old', to: 'job-next' }, { from: 'job-next', to: 'job-old' }] }));
    await expect(session.safeClose()).rejects.toThrow('cyclic retry recovery link');
  });
});
