import { describe, expect, it } from 'vitest';
import { FakeJobService, FakeSetupService } from '../../apps/desktop/src/main/services.js';
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
});
