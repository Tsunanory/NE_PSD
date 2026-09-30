import { describe, expect, it } from 'vitest';
import type { JobEvent, JobSpec } from '@ne-psd/contracts';
import { loadFixture } from '@ne-psd/contracts/testing';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeJobService } from '../../apps/desktop/src/main/fake-job-service.js';
import { JobSessionController } from '../../apps/desktop/src/main/job-session-controller.js';

describe('explicit development failure driver', () => {
  it('emits one frozen transient failure and retries only its failed asset as attempt two', async () => {
    const fake = new FakeJobService();
    const { jobId } = await fake.start(loadFixture<JobSpec>('job.interactive.json'));
    const observed: JobEvent[] = [];
    const unsubscribe = fake.subscribe(jobId, (event) => observed.push(event));
    await fake.failFakeJob(jobId);
    const failed = await fake.snapshot(jobId);
    expect(failed).toMatchObject({ state: 'failed', complete: 0, failed: 1, assets: [{ status: 'failed', attempt: 1, error: { code: 'FAKE_TRANSIENT', retryable: true } }] });
    expect(Object.isFrozen(failed)).toBe(true);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ jobId, sequence: 2, snapshot: { state: 'failed' } });
    expect(Object.isFrozen(observed[0]?.snapshot)).toBe(true);
    const successor = await fake.retryFailed(jobId);
    expect(successor.jobId).not.toBe(jobId);
    expect(await fake.snapshot(jobId)).toBe(failed);
    expect(await fake.snapshot(successor.jobId)).toMatchObject({ state: 'running', failed: 0, assets: [{ status: 'queued', attempt: 2, error: null }] });
    expect(fake.events(successor.jobId).map((event) => event.sequence)).toEqual([2, 3]);
    await fake.failFakeJob(successor.jobId);
    expect((await fake.snapshot(successor.jobId)).assets[0]?.attempt).toBe(2);
    await expect(fake.retryFailed(successor.jobId)).rejects.toThrow('attempt limit reached');
    expect(fake.metrics(successor.jobId)).toMatchObject({ eventCount: 3, lastSequence: 4 });
    unsubscribe();
    expect(fake.metrics(jobId).activeSubscriptions).toBe(0);
  });

  it('rejects failure injection for an unknown or non-running job', async () => {
    const fake = new FakeJobService();
    await expect(fake.failFakeJob('missing')).rejects.toThrow('unknown fake job');
    const { jobId } = await fake.start(loadFixture<JobSpec>('job.interactive.json'));
    await fake.pause(jobId);
    await expect(fake.failFakeJob(jobId)).rejects.toThrow('must be running');
    await expect(fake.retryFailed(jobId)).rejects.toThrow('no retryable failure');
  });

  it('pauses the retry successor through safe close and keeps emitted attempts sequenced', async () => {
    const fake = new FakeJobService();
    const { jobId } = await fake.start(loadFixture<JobSpec>('job.interactive.json'));
    const sessions = new JobSessionController({ jobs: fake, userDataDirectory: mkdtempSync(join(tmpdir(), 'ne-psd-retry-close-')), developmentFake: true });
    await sessions.recordStarted(jobId);
    await fake.failFakeJob(jobId);
    const successor = await fake.retryFailed(jobId);
    await sessions.recordRetry(jobId, successor.jobId);
    await expect(sessions.safeClose()).resolves.toBeUndefined();
    expect(await fake.snapshot(successor.jobId)).toMatchObject({ state: 'paused', assets: [{ status: 'queued', attempt: 2 }] });
    expect((await fake.snapshot(jobId)).state).toBe('failed');
    expect(fake.events(successor.jobId).map((event) => event.sequence)).toEqual([2, 3, 4]);
    await fake.resume(successor.jobId);
    expect(await fake.completeFakeJob(successor.jobId)).toMatchObject({ state: 'completed', complete: 1, assets: [{ status: 'complete', attempt: 2 }] });
    expect(fake.events(successor.jobId).map((event) => event.sequence)).toEqual([2, 3, 4, 5, 6]);
  });

  it('cancels a retry successor without leaving its overlay running', async () => {
    const fake = new FakeJobService();
    const { jobId } = await fake.start(loadFixture<JobSpec>('job.interactive.json'));
    await fake.failFakeJob(jobId);
    const successor = await fake.retryFailed(jobId);
    await fake.cancel(successor.jobId);
    expect(await fake.snapshot(successor.jobId)).toMatchObject({ state: 'cancelled', assets: [{ status: 'cancelled', attempt: 2 }] });
    expect(fake.events(successor.jobId).map((event) => event.sequence)).toEqual([2, 3, 4]);
  });
});
