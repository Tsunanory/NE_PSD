import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RenderRunner, createAttemptWorkspace, type PhotoshopLease } from '@ne-psd/core';
import type { JobRepository } from '@ne-psd/core';
import type { PhotoshopBackend, RenderEvidence } from '@ne-psd/contracts';

const job = { jobId: 'job', profile: {}, assets: [] } as never;
const asset = { assetId: 'asset', source: {}, sourceBytes: 1 } as never;
const root = { rootId: 'out', canonicalRoot: '/tmp', canonicalRootIdentity: 'x' };
const repository = { transition: () => undefined } as unknown as JobRepository;
const lease: PhotoshopLease = { acquire: async () => undefined, diagnostics: async () => ({ host: 'test', pid: 1, processStart: 'now', jobId: 'job' }), release: async () => undefined, retain: async () => undefined, safeToRelease: async () => true } as PhotoshopLease;
const leaseFor = (jobId: string): PhotoshopLease => ({ ...lease, diagnostics: async () => ({ host: 'test', pid: 1, processStart: 'now', jobId }) });
const evidence = {} as RenderEvidence;

describe('render runner', () => {
  it('does not issue a second mutation after timeout while the first settles late', async () => {
    let calls = 0;
    let settle!: (value: RenderEvidence) => void;
    const backend = { render: async () => { calls += 1; return new Promise<RenderEvidence>((resolve) => { settle = resolve; }); }, recover: async () => ({ safe: false, evidencePaths: [] }) } as unknown as PhotoshopBackend;
    const runner = new RenderRunner({ repository, backend, lease, outputRoot: root, timeoutMs: 5 });
    await expect(runner.render(job, asset, 1)).rejects.toMatchObject({ code: 'AMBIGUOUS_STATE' });
    settle(evidence);
    await expect(runner.render(job, asset, 1)).rejects.toMatchObject({ code: 'MUTATION_BLOCKED' });
    expect(calls).toBe(1);
  });

  it('copies validated source bytes into each owned attempt workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ne-psd-runner-root-'));
    const sourcePath = join(root, 'source.png');
    const bytes = Buffer.from('source-bytes');
    await writeFile(sourcePath, bytes);
    const source = { absolutePath: sourcePath, relativePath: 'source.png', sha256: 'f'.repeat(64), bytes: bytes.length, selectedAtMs: Date.now() };
    const backend = { render: async (request: { stagingDirectory: string }) => { const copied = await readFile(join(request.stagingDirectory, 'source.png')); expect(copied).toEqual(bytes); return evidence; }, recover: async () => ({ safe: true, evidencePaths: [] }) } as unknown as PhotoshopBackend;
    const actualSource = { ...source, sha256: (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex') };
    const copiedRunner = new RenderRunner({ repository, backend, lease: leaseFor('copy-job-2'), outputRoot: { rootId: 'out', canonicalRoot: root, canonicalRootIdentity: 'x' }, timeoutMs: 100, source: actualSource });
    await expect(copiedRunner.render({ ...job, jobId: 'copy-job-2' }, asset, 1)).resolves.toBeTruthy();
  });

  it('rejects traversal and symlink attempt workspace paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ne-psd-workspace-root-'));
    await expect(createAttemptWorkspace(root, '../escape', 'asset', 1)).rejects.toThrow(/unsafe job/i);
    const outside = await mkdtemp(join(tmpdir(), 'ne-psd-workspace-outside-'));
    await mkdir(join(root, '.ne-psd-staging'), { recursive: true });
    await symlink(outside, join(root, '.ne-psd-staging', 'job'));
    await expect(createAttemptWorkspace(root, 'job', 'asset', 1)).rejects.toThrow(/symlink/i);
  });
});
