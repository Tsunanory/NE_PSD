import { describe, expect, it, vi } from 'vitest';
import type { JobEvent } from '@ne-psd/contracts';
import { JobStore, boundedAssetWindow } from '../../apps/desktop/src/renderer/jobs/job-store.js';
import { jobEvent, jobSnapshot } from './fixtures/job-events.js';

const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

describe('durable desktop job store', () => {
  it('holds one subscription, rejects stale/wrong jobs, and refreshes gaps', async () => {
    let listener: ((event: JobEvent) => void) | undefined;
    let hydrated = 0;
    const unsubscribe = vi.fn();
    const store = new JobStore({ snapshot: async () => { hydrated++; return { ...jobSnapshot('job-1', hydrated === 2 ? 'paused' : 'running'), sequence: hydrated === 2 ? 3 : 0 }; },
      subscribe: (_id, next) => { listener = next; return unsubscribe; } });
    await store.connect('job-1');
    listener!(jobEvent(1));
    listener!(jobEvent(1, 'job-2'));
    listener!(jobEvent(1, 'job-1', 'completed'));
    expect(store.getSnapshot()?.state).toBe('running');
    listener!(jobEvent(3));
    await tick();
    expect(store.getSnapshot()?.state).toBe('paused');
    expect(hydrated).toBe(2);
    await store.connect('job-1');
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    store.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });
  it('does not apply an old async hydration after reconnect', async () => {
    let resolveOld!: (value: ReturnType<typeof jobSnapshot> & { sequence: number }) => void;
    let oldListener!: (event: JobEvent) => void;
    const store = new JobStore({ snapshot: (id) => id === 'job-1' ? new Promise((resolve) => { resolveOld = resolve; }) : Promise.resolve({ ...jobSnapshot('job-2', 'paused'), sequence: 5 }),
      subscribe: (_id, next) => { oldListener = next; return () => {}; } });
    const pending = store.connect('job-1');
    await store.connect('job-2');
    resolveOld({ ...jobSnapshot('job-1'), sequence: 0 });
    await pending;
    oldListener(jobEvent(6, 'job-1'));
    expect(store.getSnapshot()?.jobId).toBe('job-2');
  });
  it('binds retry successor and preserves old job evidence', async () => {
    const unsubscribed: string[] = [];
    const store = new JobStore({ snapshot: async (id) => ({ ...jobSnapshot(id, id === 'job-1' ? 'failed' : 'running'), sequence: 1 }),
      subscribe: (id) => () => unsubscribed.push(id), retryFailed: async () => ({ jobId: 'job-2' }) });
    await store.connect('job-1');
    await store.retry();
    expect(store.jobId).toBe('job-2');
    expect(store.previousJobs.map((job) => job.jobId)).toEqual(['job-1']);
    expect(unsubscribed).toEqual(['job-1']);
  });
  it('renders a bounded window for 10,000 assets', () => {
    const assets = jobSnapshot('job-1', 'running', 10_000).assets;
    expect(boundedAssetWindow(assets, 9_975).length).toBe(25);
    expect(boundedAssetWindow(assets, 0).length).toBeLessThanOrEqual(50);
  });
});

describe('main job forwarding', () => {
  it('holds one service subscription and rejects wrong/stale events', async () => {
    const { JobEventForwarder } = await import('../../apps/desktop/src/main/job-subscription.js');
    const callbacks = new Map<string, (event: JobEvent) => void>();
    const unsubscribed: string[] = [];
    const service = { subscribe: (id: string, listener: (event: JobEvent) => void) => { callbacks.set(id, listener); return () => unsubscribed.push(id); } };
    const delivered: number[] = [];
    const forwarder = new JobEventForwarder(service);
    forwarder.attach('job-1', (event) => delivered.push(event.sequence));
    const stale = callbacks.get('job-1')!;
    stale(jobEvent(1)); stale(jobEvent(1)); stale(jobEvent(2, 'job-2'));
    forwarder.attach('job-2', (event) => delivered.push(event.sequence));
    stale(jobEvent(3));
    callbacks.get('job-2')!(jobEvent(1, 'job-2'));
    forwarder.dispose();
    expect(delivered).toEqual([1, 1]);
    expect(unsubscribed).toEqual(['job-1', 'job-2']);
  });
});

describe('safe close', () => {
  it('closes only after pause and persisted safe state', async () => {
    const { closeActiveJob } = await import('../../apps/desktop/src/main/shutdown.js');
    const order: string[] = [];
    await closeActiveJob('safe-pause-and-close', async () => { order.push('pause'); }, async () => { order.push('wait'); return { persisted: true, state: 'paused' }; }, () => order.push('close'));
    expect(order).toEqual(['pause', 'wait', 'close']);
    await expect(closeActiveJob('safe-pause-and-close', async () => {}, async () => ({ persisted: false, state: 'pausing' }), () => order.push('bad-close'))).rejects.toThrow();
    expect(order).not.toContain('bad-close');
  });
});
