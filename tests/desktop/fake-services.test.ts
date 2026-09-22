import { describe, expect, it } from 'vitest';
import { FakeJobService, FakeSetupService } from '../../apps/desktop/src/main/services.js';
import { loadFixture } from '@ne-psd/contracts/testing';
import type { JobSpec } from '@ne-psd/contracts';

describe('desktop independent fakes', () => {
  it('returns frozen sequence-numbered snapshots and serializes controls', async () => {
    const spec = loadFixture<JobSpec>('job.interactive.json');
    const service = new FakeJobService();
    const started = await service.start(spec);
    const first = await service.snapshot(started.jobId);
    await Promise.all([service.pause(started.jobId), service.resume(started.jobId)]);
    const last = await service.snapshot(started.jobId);
    expect(last.sequence).toBeGreaterThan(first.sequence);
    expect(Object.isFrozen(last)).toBe(true);
    expect(last.state).toBe('running');
  });

  it('exposes deterministic setup states without environment selection', async () => {
    const setup = new FakeSetupService();
    expect(await setup.state('duplicate-layer-names')).toBe('blocked');
    expect(await setup.state('valid-text-only-model')).toBe('ready');
  });
});
