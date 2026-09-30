import { describe, expect, it, onTestFinished } from 'vitest';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { mkdtemp, readFile, symlink, writeFile, mkdir, realpath, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RenderRunner, BackendSerialization, JobRepository, createAttemptWorkspace, type PhotoshopLease } from '@ne-psd/core';
import type { PhotoshopBackend, RenderEvidence, JobSpec } from '@ne-psd/contracts';
import { readFixture } from '../fixtures/read-fixture.js';

const job = { jobId: 'job', profile: {}, assets: [] } as never;
const asset = { assetId: 'asset', source: {}, sourceBytes: 1 } as never;
const repository = { transition: () => undefined } as unknown as JobRepository;
const lease: PhotoshopLease = { acquire: async () => undefined, diagnostics: async () => ({ host: 'test', pid: 1, processStart: 'now', jobId: 'job' }), release: async () => undefined, retain: async () => undefined, safeToRelease: async () => true } as PhotoshopLease;
const leaseFor = (jobId: string): PhotoshopLease => ({ ...lease, diagnostics: async () => ({ host: 'test', pid: 1, processStart: 'now', jobId }) });
const evidence = {} as RenderEvidence;

async function durableScenario() {
  const directory = await mkdtemp(join(tmpdir(), 'ne-psd-runner-durable-'));
  const output = join(directory, 'output');
  await mkdir(output);
  const canonicalRoot = await realpath(output);
  const info = await stat(canonicalRoot);
  const binding = { rootId: 'fixture-output', canonicalRoot, canonicalRootIdentity: createHash('sha256').update(`${canonicalRoot}|${info.dev}|${info.ino}`).digest('hex') };
  const repository = new JobRepository(join(directory, 'state.sqlite'));
  const job = readFixture<JobSpec>('job.interactive.json');
  repository.recordQualification({ qualificationId: job.profile.qualificationId, profileId: job.profile.profileId, profileSha256: job.profile.profileSha256, profile: job.profile, evidence: { source: 'fixture' } });
  const addJob = (jobId: string): JobSpec => {
    const next = { ...job, jobId };
    repository.createJob(next, null, binding);
    return next;
  };
  onTestFinished(async () => { repository.close(); await rm(directory, { recursive: true, force: true }); });
  return { repository, binding, addJob, asset: job.assets[0]!, workspace: (jobId: string) => join(output, '.ne-psd-staging', jobId, job.assets[0]!.assetId, '1') };
}

function trackedLease(overrides: Partial<PhotoshopLease> = {}) {
  const calls = { acquire: 0, diagnostics: 0, release: 0, retain: 0 };
  let activeJob = '';
  const lease: PhotoshopLease = {
    acquire: async (jobId) => { calls.acquire++; activeJob = jobId; },
    diagnostics: async () => { calls.diagnostics++; return { host: 'test', pid: 1, processStart: 'now', jobId: activeJob }; },
    release: async () => { calls.release++; },
    retain: async () => { calls.retain++; },
    safeToRelease: async () => true,
    ...overrides,
  };
  return { lease, calls };
}

describe('render runner', () => {
  it('rejects a blocked render before workspace, lease, database, or backend effects', async () => {
    const f = await durableScenario();
    const job = f.addJob('blocked-admission');
    const { lease, calls } = trackedLease();
    const serialization = BackendSerialization.forLease(lease);
    serialization.block();
    let renders = 0;
    const backend = { render: async () => { renders++; return evidence; } } as unknown as PhotoshopBackend;
    const runner = new RenderRunner({ repository: f.repository, backend, lease, outputRoot: f.binding, serialization });

    await expect(runner.renderWithRetry(job, f.asset)).rejects.toMatchObject({ code: 'MUTATION_BLOCKED' });
    expect(existsSync(f.workspace(job.jobId))).toBe(false);
    expect(f.repository.snapshot(job.jobId).assets[0]).toMatchObject({ status: 'queued', attempt: 0 });
    expect(calls).toEqual({ acquire: 0, diagnostics: 0, release: 0, retain: 0 });
    expect(renders).toBe(0);
  });

  it('rejects a busy second runner before its workspace, lease, or database changes', async () => {
    const f = await durableScenario();
    const firstJob = f.addJob('busy-first');
    const secondJob = f.addJob('busy-second');
    const { lease, calls } = trackedLease();
    let started!: () => void;
    const startedRender = new Promise<void>((resolve) => { started = resolve; });
    let finish!: (value: RenderEvidence) => void;
    let renders = 0;
    const backend = { render: async () => { renders++; started(); return new Promise<RenderEvidence>((resolve) => { finish = resolve; }); } } as unknown as PhotoshopBackend;
    const first = new RenderRunner({ repository: f.repository, backend, lease, outputRoot: f.binding });
    const second = new RenderRunner({ repository: f.repository, backend, lease, outputRoot: f.binding });

    const inFlight = first.render(firstJob, f.asset, 1);
    await startedRender;
    await expect(second.renderWithRetry(secondJob, f.asset)).rejects.toMatchObject({ code: 'MUTATION_IN_PROGRESS' });
    expect(existsSync(f.workspace(secondJob.jobId))).toBe(false);
    expect(f.repository.snapshot(secondJob.jobId).assets[0]).toMatchObject({ status: 'queued', attempt: 0 });
    expect(calls.acquire).toBe(1);
    expect(calls.release).toBe(0);
    expect(renders).toBe(1);
    finish(evidence);
    await inFlight;
  });

  it('blocks another runner throughout awaited read-only recovery', async () => {
    const f = await durableScenario();
    const firstJob = f.addJob('recovery-first');
    const secondJob = f.addJob('recovery-second');
    const { lease, calls } = trackedLease();
    let recoveryStarted!: () => void;
    const enteredRecovery = new Promise<void>((resolve) => { recoveryStarted = resolve; });
    let finishRecovery!: (value: { safe: boolean; evidencePaths: string[] }) => void;
    let renders = 0;
    const backend = {
      render: async () => { renders++; throw Object.assign(new Error('uncertain save'), { code: 'AMBIGUOUS_STATE' }); },
      recover: async () => { recoveryStarted(); return new Promise<{ safe: boolean; evidencePaths: string[] }>((resolve) => { finishRecovery = resolve; }); },
    } as unknown as PhotoshopBackend;
    const first = new RenderRunner({ repository: f.repository, backend, lease, outputRoot: f.binding });
    const second = new RenderRunner({ repository: f.repository, backend, lease, outputRoot: f.binding });

    const inRecovery = first.render(firstJob, f.asset, 1);
    await enteredRecovery;
    await expect(second.render(secondJob, f.asset, 1)).rejects.toMatchObject({ code: 'MUTATION_BLOCKED' });
    expect(existsSync(f.workspace(secondJob.jobId))).toBe(false);
    expect(f.repository.snapshot(secondJob.jobId).assets[0]).toMatchObject({ status: 'queued', attempt: 0 });
    expect(calls.acquire).toBe(1);
    expect(renders).toBe(1);
    finishRecovery({ safe: false, evidencePaths: [] });
    await expect(inRecovery).rejects.toMatchObject({ code: 'AMBIGUOUS_STATE' });
  });

  it.each(['absent', 'false', 'throws', 'truthy'] as const)('retains the ambiguity barrier when release proof %s', async (proof) => {
    const f = await durableScenario();
    const firstJob = f.addJob(`proof-${proof}`);
    const secondJob = f.addJob(`proof-${proof}-next`);
    const tracked = trackedLease();
    if (proof === 'absent') delete tracked.lease.safeToRelease;
    if (proof === 'false') tracked.lease.safeToRelease = async () => false;
    if (proof === 'throws') tracked.lease.safeToRelease = async () => { throw new Error('proof unavailable'); };
    if (proof === 'truthy') tracked.lease.safeToRelease = async () => 'yes' as unknown as boolean;
    let renders = 0;
    const backend = {
      render: async () => { renders++; throw Object.assign(new Error('uncertain save'), { code: 'AMBIGUOUS_STATE' }); },
      recover: async () => ({ safe: true, evidencePaths: ['recovery.json'] }),
    } as unknown as PhotoshopBackend;
    const first = new RenderRunner({ repository: f.repository, backend, lease: tracked.lease, outputRoot: f.binding });
    const second = new RenderRunner({ repository: f.repository, backend, lease: tracked.lease, outputRoot: f.binding });

    await expect(first.renderWithRetry(firstJob, f.asset)).rejects.toMatchObject({ code: 'AMBIGUOUS_STATE' });
    await expect(second.renderWithRetry(secondJob, f.asset)).rejects.toMatchObject({ code: 'MUTATION_BLOCKED' });
    expect(f.repository.snapshot(firstJob.jobId).assets[0]).toMatchObject({ status: 'blocked', attempt: 1 });
    expect(f.repository.snapshot(secondJob.jobId).assets[0]).toMatchObject({ status: 'queued', attempt: 0 });
    expect(existsSync(f.workspace(secondJob.jobId))).toBe(false);
    expect(tracked.calls.release).toBe(0);
    expect(renders).toBe(1);
  });

  it('retains the ambiguity barrier when proven-safe recovery cannot release the lease', async () => {
    const f = await durableScenario();
    const firstJob = f.addJob('release-fails');
    const secondJob = f.addJob('release-fails-next');
    const { lease, calls } = trackedLease();
    lease.release = async () => { calls.release++; throw new Error('release failed'); };
    let renders = 0;
    const backend = {
      render: async () => { renders++; throw Object.assign(new Error('uncertain save'), { code: 'AMBIGUOUS_STATE' }); },
      recover: async () => ({ safe: true, evidencePaths: [] }),
    } as unknown as PhotoshopBackend;
    const first = new RenderRunner({ repository: f.repository, backend, lease, outputRoot: f.binding });
    const second = new RenderRunner({ repository: f.repository, backend, lease, outputRoot: f.binding });

    await expect(first.renderWithRetry(firstJob, f.asset)).rejects.toMatchObject({ code: 'AMBIGUOUS_STATE' });
    await expect(second.render(secondJob, f.asset, 1)).rejects.toMatchObject({ code: 'MUTATION_BLOCKED' });
    expect(f.repository.snapshot(firstJob.jobId).assets[0]).toMatchObject({ status: 'blocked', attempt: 1 });
    expect(f.repository.snapshot(secondJob.jobId).assets[0]).toMatchObject({ status: 'queued', attempt: 0 });
    expect(calls.release).toBe(1);
    expect(renders).toBe(1);
  });

  it('blocks a completed render when lease release lacks proof', async () => {
    const f = await durableScenario();
    const firstJob = f.addJob('completed-unproven');
    const secondJob = f.addJob('completed-unproven-next');
    const { lease, calls } = trackedLease();
    delete lease.safeToRelease;
    let renders = 0;
    const backend = { render: async () => { renders++; return evidence; } } as unknown as PhotoshopBackend;
    const first = new RenderRunner({ repository: f.repository, backend, lease, outputRoot: f.binding });
    const second = new RenderRunner({ repository: f.repository, backend, lease, outputRoot: f.binding });

    await expect(first.renderWithRetry(firstJob, f.asset)).rejects.toMatchObject({ code: 'AMBIGUOUS_STATE' });
    await expect(second.render(secondJob, f.asset, 1)).rejects.toMatchObject({ code: 'MUTATION_BLOCKED' });
    expect(f.repository.snapshot(firstJob.jobId).assets[0]).toMatchObject({ status: 'blocked', attempt: 1 });
    expect(f.repository.snapshot(secondJob.jobId).assets[0]).toMatchObject({ status: 'queued', attempt: 0 });
    expect(calls.release).toBe(0);
    expect(renders).toBe(1);
  });

  it('retries one transport failure only after a proven lease release', async () => {
    const f = await durableScenario();
    const job = f.addJob('transport-retry');
    const { lease, calls } = trackedLease();
    let renders = 0;
    const backend = { render: async () => { renders++; if (renders === 1) throw Object.assign(new Error('read transport failed'), { code: 'TRANSPORT_FAILURE' }); return evidence; } } as unknown as PhotoshopBackend;
    const runner = new RenderRunner({ repository: f.repository, backend, lease, outputRoot: f.binding });

    await expect(runner.renderWithRetry(job, f.asset)).resolves.toBeTruthy();
    expect(f.repository.snapshot(job.jobId).assets[0]).toMatchObject({ status: 'rendering', attempt: 2 });
    expect(calls.release).toBe(2);
    expect(renders).toBe(2);
  });

  it('does not retry a transport failure when release proof is false', async () => {
    const f = await durableScenario();
    const job = f.addJob('transport-unproven');
    const { lease, calls } = trackedLease({ safeToRelease: async () => false });
    let renders = 0;
    const backend = { render: async () => { renders++; throw Object.assign(new Error('read transport failed'), { code: 'TRANSPORT_FAILURE' }); } } as unknown as PhotoshopBackend;
    const runner = new RenderRunner({ repository: f.repository, backend, lease, outputRoot: f.binding });

    await expect(runner.renderWithRetry(job, f.asset)).rejects.toMatchObject({ code: 'AMBIGUOUS_STATE' });
    expect(f.repository.snapshot(job.jobId).assets[0]).toMatchObject({ status: 'blocked', attempt: 1 });
    expect(existsSync(join(f.binding.canonicalRoot, '.ne-psd-staging', job.jobId, f.asset.assetId, '2'))).toBe(false);
    expect(calls.release).toBe(0);
    expect(renders).toBe(1);
  });

  it('admits a new mutation only after safe recovery, release proof, and release complete', async () => {
    const f = await durableScenario();
    const firstJob = f.addJob('safe-recovery-first');
    const secondJob = f.addJob('safe-recovery-second');
    const { lease, calls } = trackedLease();
    let releaseStarted!: () => void;
    const enteredRelease = new Promise<void>((resolve) => { releaseStarted = resolve; });
    let finishRelease!: () => void;
    lease.release = async () => { calls.release++; if (calls.release === 1) { releaseStarted(); await new Promise<void>((resolve) => { finishRelease = resolve; }); } };
    let renders = 0;
    const backend = {
      render: async () => { renders++; if (renders === 1) throw Object.assign(new Error('uncertain save'), { code: 'AMBIGUOUS_STATE' }); return evidence; },
      recover: async () => ({ safe: true, evidencePaths: [] }),
    } as unknown as PhotoshopBackend;
    const first = new RenderRunner({ repository: f.repository, backend, lease, outputRoot: f.binding });
    const second = new RenderRunner({ repository: f.repository, backend, lease, outputRoot: f.binding });

    const recovering = first.renderWithRetry(firstJob, f.asset);
    await enteredRelease;
    await expect(second.render(secondJob, f.asset, 1)).rejects.toMatchObject({ code: 'MUTATION_BLOCKED' });
    expect(f.repository.snapshot(secondJob.jobId).assets[0]).toMatchObject({ status: 'queued', attempt: 0 });
    finishRelease();
    await expect(recovering).rejects.toMatchObject({ code: 'AMBIGUOUS_RECOVERED' });
    await expect(second.render(secondJob, f.asset, 1)).resolves.toBeTruthy();
    expect(renders).toBe(2);
  });

  it('does not leave a parent abort listener or deadline after lease acquire fails', async () => {
    const f = await durableScenario();
    const job = f.addJob('acquire-fails');
    const parent = new AbortController();
    const listenersBefore = getEventListeners(parent.signal, 'abort').length;
    const { lease } = trackedLease({ acquire: async () => { throw new Error('lease unavailable'); } });
    const backend = { render: async () => evidence } as unknown as PhotoshopBackend;
    const runner = new RenderRunner({ repository: f.repository, backend, lease, outputRoot: f.binding, timeoutMs: 5 });

    await expect(runner.render(job, f.asset, 1, parent.signal)).rejects.toThrow('lease unavailable');
    expect(getEventListeners(parent.signal, 'abort')).toHaveLength(listenersBefore);
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(f.repository.snapshot(job.jobId).assets[0]).toMatchObject({ status: 'queued', attempt: 0 });
  });

  it('does not issue a second mutation after timeout while the first settles late', async () => {
    const f = await durableScenario();
    const firstJob = f.addJob('late-first');
    const secondJob = f.addJob('late-second');
    const { lease } = trackedLease();
    let calls = 0;
    let settle!: (value: RenderEvidence) => void;
    const backend = { render: async () => { calls += 1; return new Promise<RenderEvidence>((resolve) => { settle = resolve; }); }, recover: async () => ({ safe: false, evidencePaths: [] }) } as unknown as PhotoshopBackend;
    const first = new RenderRunner({ repository: f.repository, backend, lease, outputRoot: f.binding, timeoutMs: 5 });
    const second = new RenderRunner({ repository: f.repository, backend, lease, outputRoot: f.binding, timeoutMs: 5 });
    await expect(first.render(firstJob, f.asset, 1)).rejects.toMatchObject({ code: 'AMBIGUOUS_STATE' });
    settle(evidence);
    await Promise.resolve();
    await expect(second.render(secondJob, f.asset, 1)).rejects.toMatchObject({ code: 'MUTATION_BLOCKED' });
    expect(f.repository.snapshot(firstJob.jobId).assets[0]).toMatchObject({ status: 'blocked', attempt: 1 });
    expect(f.repository.snapshot(secondJob.jobId).assets[0]).toMatchObject({ status: 'queued', attempt: 0 });
    expect(existsSync(f.workspace(secondJob.jobId))).toBe(false);
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
