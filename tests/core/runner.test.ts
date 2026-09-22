import { describe, expect, it } from 'vitest';
import { RenderRunner, type PhotoshopLease } from '@ne-psd/core';
import type { JobRepository } from '@ne-psd/core';
import type { PhotoshopBackend, RenderEvidence } from '@ne-psd/contracts';

const job = { jobId: 'job', profile: {}, assets: [] } as never;
const asset = { assetId: 'asset', source: {}, sourceBytes: 1 } as never;
const root = { rootId: 'out', canonicalRoot: '/tmp', canonicalRootIdentity: 'x' };
const repository = { transition: () => undefined } as unknown as JobRepository;
const lease: PhotoshopLease = { acquire: async () => undefined, diagnostics: async () => ({ host: 'test', pid: 1, processStart: 'now', jobId: 'job' }), release: async () => undefined, retain: async () => undefined };
const evidence = {} as RenderEvidence;

describe('render runner', () => {
  it('does not issue a second mutation after timeout while the first settles late', async () => {
    let calls = 0;
    let settle!: (value: RenderEvidence) => void;
    const backend = { render: async () => { calls += 1; return new Promise<RenderEvidence>((resolve) => { settle = resolve; }); }, recover: async () => ({ safe: false, evidencePaths: [] }) } as unknown as PhotoshopBackend;
    const runner = new RenderRunner({ repository, backend, lease, outputRoot: root, timeoutMs: 5 });
    await expect(runner.render(job, asset, 1)).rejects.toMatchObject({ code: 'AMBIGUOUS_STATE' });
    settle(evidence);
    await expect(runner.render(job, asset, 1)).rejects.toMatchObject({ code: 'AMBIGUOUS_STATE' });
    expect(calls).toBe(2);
  });
});
