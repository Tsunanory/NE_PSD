import { describe, expect, it } from 'vitest';
import { FakeSetupService } from '../../apps/desktop/src/main/services.js';
import { FakeJobService, createFakeCorpusSpec } from '../../apps/desktop/src/main/fake-job-service.js';
import { loadFixture } from '@ne-psd/contracts/testing';
import type { JobSpec } from '@ne-psd/contracts';

describe('desktop independent fakes', () => {
  it('returns contract-shaped frozen snapshots and sequence-numbered events', async () => {
    const spec = loadFixture<JobSpec>('job.interactive.json');
    const service = new FakeJobService();
    const started = await service.start(spec);
    const first = service.events(started.jobId).at(-1)!.sequence;
    await Promise.all([service.pause(started.jobId), service.resume(started.jobId)]);
    const last = await service.snapshot(started.jobId);
    expect(service.events(started.jobId).at(-1)!.sequence).toBeGreaterThan(first);
    expect('sequence' in last).toBe(false);
    expect(Object.isFrozen(last)).toBe(true);
    expect(last.state).toBe('running');
  });

  it('exposes deterministic setup states without environment selection', async () => {
    const setup = new FakeSetupService();
    expect(await setup.state('duplicate-layer-names')).toBe('blocked');
    expect(await setup.state('valid-text-only-model')).toBe('ready');
  });
  it('runs 10,000 valid fake assets through start, pause, resume, final event and frozen snapshot', async () => {
    const spec = createFakeCorpusSpec(10_000);
    expect(spec.assets).toHaveLength(10_000);
    expect(Object.isFrozen(spec.assets[0])).toBe(true);
    const service = new FakeJobService();
    const observed: number[] = [];
    const job = await service.start(spec);
    const unsubscribe = service.subscribe(job.jobId, event => observed.push(event.sequence));
    expect(service.metrics(job.jobId).activeSubscriptions).toBe(1);
    await service.pause(job.jobId);
    await service.resume(job.jobId);
    const final = await service.completeFakeJob(job.jobId);
    unsubscribe();
    unsubscribe();
    expect(service.metrics(job.jobId)).toMatchObject({ activeSubscriptions: 0, eventCount: 4, lastSequence: 4 });
    expect(final).toMatchObject({ state: 'completed', total: 10_000, complete: 10_000 });
    expect(final.assets).toHaveLength(10_000);
    expect(Object.isFrozen(final.assets[0])).toBe(true);
    expect(observed).toEqual([...observed].sort((a, b) => a - b));
    expect(new Set(observed).size).toBe(observed.length);
    expect(service.events(job.jobId).at(-1)?.snapshot).toMatchObject({ state: 'completed', complete: 10_000 });
  }, 30_000);
  it('bounds corpus input and refuses false completion after cancellation', async () => {
    expect(() => createFakeCorpusSpec(10_001)).toThrow();
    expect(() => createFakeCorpusSpec(1.5)).toThrow();
    const service = new FakeJobService();
    const { jobId } = await service.start(createFakeCorpusSpec(1, 'cancel-test'));
    await service.cancel(jobId);
    await expect(service.completeFakeJob(jobId)).rejects.toThrow(/running/);
  });
});
