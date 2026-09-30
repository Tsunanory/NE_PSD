import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { JobView } from '../../apps/desktop/src/renderer/jobs/JobView.js';
import { JobActionController, controlAvailability, pendingControl } from '../../apps/desktop/src/renderer/jobs/job-controls.js';
import { jobSnapshot } from './fixtures/job-events.js';

describe('safe job controls', () => {
  it('keeps action pending until the service resolves and prevents a duplicate', async () => {
    let resolve!: () => void;
    const pause = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    const controller = new JobActionController({ pause, resume: async () => {}, cancel: async () => {}, retry: async () => ({ jobId: 'next' }) });
    const first = controller.run('pause', 'running');
    expect(controller.pending).toBe('pause');
    await expect(controller.run('pause', 'running')).rejects.toThrow(/pending/);
    expect(pause).toHaveBeenCalledTimes(1);
    resolve();
    await first;
    expect(controller.pending).toBe(null);
    expect(controller.lastResult).toBe(null);
  });
  it('leaves failure visible and never invents a state transition', async () => {
    const controller = new JobActionController({ pause: async () => { throw new Error('offline'); }, resume: async () => {}, cancel: async () => {}, retry: async () => ({ jobId: 'next' }) });
    await expect(controller.run('pause', 'running')).rejects.toThrow('offline');
    expect(controller.error).toBe('offline');
    expect(controller.pending).toBe(null);
    expect(controlAvailability('running')).toEqual({ pause: true, resume: false, cancel: true, retry: false });
    expect(pendingControl('pause').message).toContain('Завершается');
  });
  it('shows service state and at most 50 asset rows', () => {
    const snapshot = jobSnapshot('job-1', 'running', 10_000);
    const markup = renderToStaticMarkup(<JobView state="running" snapshot={snapshot} />);
    expect((markup.match(/data-asset-id=/g) ?? []).length).toBeLessThanOrEqual(50);
    expect(markup).toContain('0 / 10000');
    expect(markup).not.toContain('Готовые результаты');
  });
  it('does not present staged output as committed', () => {
    const snapshot = jobSnapshot('job-1');
    snapshot.assets[0]!.status = 'readyToCommit';
    const staged = renderToStaticMarkup(<JobView state="running" snapshot={snapshot} selectedAssetId="asset-0" onOpenCommittedOutput={async () => {}} />);
    expect(staged).not.toContain('Готовые результаты');
    snapshot.assets[0]!.status = 'complete';
    const committed = renderToStaticMarkup(<JobView state="running" snapshot={snapshot} selectedAssetId="asset-0" onOpenCommittedOutput={async () => {}} />);
    expect(committed).toContain('Готовые результаты');
  });
});
