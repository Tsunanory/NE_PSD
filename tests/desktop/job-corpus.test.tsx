import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { JobSpec, JobSnapshot } from '@ne-psd/contracts';
import { loadFixture } from '@ne-psd/contracts/testing';
import { FakeJobService } from '../../apps/desktop/src/main/fake-job-service.js';
import { JobView } from '../../apps/desktop/src/renderer/jobs/JobView.js';
import { controlAvailability } from '../../apps/desktop/src/renderer/jobs/job-controls.js';
import { JobStore } from '../../apps/desktop/src/renderer/jobs/job-store.js';
import { assetStatuses, jobStates } from './fixtures/scenarios.js';
import { jobSnapshot, snapshotForAssetStatus } from './fixtures/job-events.js';

const spec = () => loadFixture<JobSpec>('job.interactive.json');

describe('deterministic fake job corpus', () => {
  it('rehydrates and renders every frozen JobState with service-allowed controls', async () => {
    expect(jobStates).toHaveLength(8);
    for (const state of jobStates) {
      const value = jobSnapshot(`state-${state}`, state, 1);
      const fake = new FakeJobService({ initialSnapshots: { [value.jobId]: value } });
      const restored = await fake.snapshot(value.jobId);
      expect(Object.isFrozen(restored)).toBe(true);
      const html = renderToStaticMarkup(<JobView state={restored.state} snapshot={restored} />);
      expect(html).toContain(state === 'blocked' ? 'Состояние Photoshop не подтверждено' : `Текущее состояние: ${state}`);
      const controls = controlAvailability(state);
      expect(controls.pause).toBe(state === 'running');
      expect(controls.resume).toBe(state === 'paused');
      expect(controls.retry).toBe(state === 'failed' || state === 'blocked');
      expect(controls.cancel).toBe(['running', 'pausing', 'paused'].includes(state));
    }
  });

  it('renders every AssetStatus, keeps errors visible and exposes output only when complete', async () => {
    expect(assetStatuses).toHaveLength(8);
    for (const status of assetStatuses) {
      const value = snapshotForAssetStatus(status);
      const fake = new FakeJobService({ initialSnapshots: { [value.jobId]: value } });
      const restored = await fake.snapshot(value.jobId);
      const html = renderToStaticMarkup(<JobView state={restored.state} snapshot={restored} selectedAssetId="asset-1" onOpenCommittedOutput={async () => {}} />);
      expect(html).toContain(`${status}; попытка`);
      expect(html.includes('Готовые результаты')).toBe(status === 'complete');
      expect(restored.complete).toBe(status === 'complete' ? 1 : 0);
      if (status === 'failed' || status === 'blocked') expect(html).toContain(`${status} evidence retained`);
    }
  });

  it.each(['rendering', 'reviewing'] as const)('pauses during %s without marking the asset published', async (status) => {
    const value = snapshotForAssetStatus(status, `pause-${status}`);
    const fake = new FakeJobService({ initialSnapshots: { [value.jobId]: value } });
    const seen: JobSnapshot['state'][] = [];
    const unsubscribe = fake.subscribe(value.jobId, (event) => seen.push(event.snapshot.state));
    await fake.pause(value.jobId);
    expect(await fake.snapshot(value.jobId)).toMatchObject({ state: 'paused', complete: 0, assets: [{ status }] });
    await fake.resume(value.jobId);
    expect(seen).toEqual(['paused', 'running']);
    unsubscribe();
  });

  it('cancels only after successful fake control and preserves state on scheduled failure', async () => {
    const value = snapshotForAssetStatus('rendering', 'cancel-safe');
    const fake = new FakeJobService({ initialSnapshots: { [value.jobId]: value }, failures: { cancelDuringChildSave: 1 } });
    await expect(fake.cancel(value.jobId)).rejects.toThrow('cancelDuringChildSave');
    expect((await fake.snapshot(value.jobId)).state).toBe('running');
    await fake.cancel(value.jobId);
    expect(await fake.snapshot(value.jobId)).toMatchObject({ state: 'cancelled', complete: 0, assets: [{ status: 'cancelled' }] });
  });

  it('keeps reviewer-offline evidence pending, then permits explicit review and rejects a conflicting attestation', async () => {
    const fake = new FakeJobService({ failures: { reviewOffline: 1 } });
    const { jobId } = await fake.start(spec());
    const assetId = spec().assets[0]!.assetId;
    await expect(fake.visualReview(jobId, assetId)).rejects.toThrow('reviewOffline');
    expect((await fake.snapshot(jobId)).complete).toBe(0);
    const request = await fake.visualReview(jobId, assetId);
    expect(request?.artifacts.map((item) => item.variantId)).toEqual(['1', '2', '3']);
    await fake.submitVisualAttestation(request!.requestId, 'reject', 'visible defect');
    await expect(fake.submitVisualAttestation(request!.requestId, 'approve', '')).rejects.toThrow('conflicting');
  });

  it('recovers the completed snapshot when publish succeeded but its final event was lost', async () => {
    const fake = new FakeJobService({ failures: { crashAfterPublishBeforeDb: 1 } });
    const { jobId } = await fake.start(spec());
    await expect(fake.completeFakeJob(jobId)).rejects.toThrow('crashAfterPublishBeforeDb');
    expect(fake.events(jobId)).toHaveLength(1);
    const store = new JobStore({ snapshot: (id) => fake.snapshot(id), subscribe: (id, next) => fake.subscribe(id, next) });
    await store.connect(jobId);
    expect(store.getSnapshot()).toMatchObject({ state: 'completed', complete: spec().assets.length });
    store.dispose();
  });

  it('keeps ambiguous and staged-review snapshots available after a process-style restart', async () => {
    const blocked = snapshotForAssetStatus('blocked', 'ambiguous-photoshop');
    const reviewing = snapshotForAssetStatus('reviewing', 'restart-staged-review');
    const restarted = new FakeJobService({ initialSnapshots: { [blocked.jobId]: blocked, [reviewing.jobId]: reviewing } });
    expect(await restarted.snapshot(blocked.jobId)).toMatchObject({ state: 'blocked', blocked: 1, assets: [{ error: { category: 'ambiguousState' } }] });
    expect(await restarted.snapshot(reviewing.jobId)).toMatchObject({ state: 'running', complete: 0, assets: [{ status: 'reviewing' }] });
  });

  it('retains an exhausted failure when the service rejects a third attempt', async () => {
    const exhausted = snapshotForAssetStatus('failed', 'attempt-limit');
    exhausted.assets[0]!.attempt = 2;
    const store = new JobStore({ snapshot: async () => exhausted, subscribe: () => () => {}, retryFailed: async () => { throw new Error('attempt limit reached'); } });
    await store.connect(exhausted.jobId);
    await expect(store.retry()).rejects.toThrow('attempt limit reached');
    expect(store.jobId).toBe(exhausted.jobId);
    expect(store.getSnapshot()?.assets[0]?.attempt).toBe(2);
    expect(store.previousJobs).toHaveLength(0);
    store.dispose();
  });
});
