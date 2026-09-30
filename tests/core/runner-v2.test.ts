import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { BackendSerialization, JobRepository, RenderRunner, createAttemptWorkspace } from '@ne-psd/core';
import type { JobSpec, PhotoshopBackendV2, PrepareRequestV2, RenderRequestV2 } from '@ne-psd/contracts';
import { readFixture } from '../fixtures/read-fixture.js';

const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const entry = (original: any, ownedRelativePath: string, bytes: number) => ({ original, ownedRelativePath, bytes, originalBeforeSha256: original.sha256, originalAfterSha256: original.sha256, copyBeforeSha256: original.sha256, copyAfterSha256: original.sha256 });
async function writeProof(root: string, path: string, value: unknown) {
  const content = Buffer.from(JSON.stringify(value));
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
  return { relativePath: path, sha256: sha(content) };
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'ne-psd-runner-v2-'));
  const output = join(dir, 'output'); const input = join(dir, 'input');
  await mkdir(output); await mkdir(join(input, 'assets'), { recursive: true });
  const sourceBytes = Buffer.from('source-contents'); const linkedBytes = Buffer.from('linked-contents');
  await writeFile(join(input, 'assets/source.png'), sourceBytes);
  await writeFile(join(input, 'assets/linked.psb'), linkedBytes);
  const identity = async (path: string) => { const canonicalRoot = await realpath(path); const info = await stat(canonicalRoot); return { canonicalRoot, canonicalRootIdentity: sha(`${canonicalRoot}|${info.dev}|${info.ino}`) }; };
  const outputRoot = { rootId: 'fixture-output', ...await identity(output) };
  const sourceRoot = { rootId: 'fixture-root', ...await identity(input) };
  const repository = new JobRepository(join(dir, 'state.sqlite'));
  const base = readFixture<JobSpec>('job.interactive.json');
  const asset = { ...base.assets[0]!, source: { ...base.assets[0]!.source, sha256: sha(sourceBytes) }, sourceBytes: sourceBytes.length };
  const job = { ...base, assets: [asset] };
  repository.recordQualification({ qualificationId: job.profile.qualificationId, profileId: job.profile.profileId, profileSha256: job.profile.profileSha256, profile: job.profile, evidence: {} });
  const addJob = (jobId: string) => { const value = { ...job, jobId }; repository.createJob(value, null, outputRoot); return value; };
  onTestFinished(async () => { if (repository.db.open) repository.close(); await rm(dir, { recursive: true, force: true }); });
  const prepared = async (request: PrepareRequestV2) => {
    const closureProof = await writeProof(request.stagingDirectory, 'checks/asset-closure.json', { operationId: request.operationId, scanned: true });
    return { schemaVersion: 2, status: 'prepared', jobId: request.jobId, assetId: request.asset.assetId, attempt: request.attempt, operationId: request.operationId,
      profileSha256: request.profile.profileSha256, sourceSha256: request.asset.source.sha256, sourceRootId: sourceRoot.rootId, sourceRootPath: sourceRoot.canonicalRoot, sourceRootIdentity: sourceRoot.canonicalRootIdentity,
      scratchDirectory: request.scratchDirectory, source: { original: request.asset.source, bytes: sourceBytes.length },
      dependencies: [{ identity: 'linked-1', original: { rootId: sourceRoot.rootId, relativePath: 'assets/linked.psb', sha256: sha(linkedBytes) }, bytes: linkedBytes.length, sourceKind: 'linked' }],
      closureComplete: true, closureProof, template: request.profile.template, stagingDirectory: request.stagingDirectory } as const;
  };
  const writeRelease = async (root: string, identity: { schemaVersion: 2; jobId: string; assetId: string; attempt: 1 | 2; operationId: string }) => {
    const ownerSnapshot = await writeProof(root, 'checks/release-owner.json', { owner: identity.operationId });
    const journalSnapshot = await writeProof(root, 'checks/release-journal.jsonl', { terminal: identity.operationId });
    return writeProof(root, 'checks/release-proof.json', { ...identity, released: true, ownerIdentitySha256: ownerSnapshot.sha256, journalSha256: journalSnapshot.sha256, ownerSnapshot, journalSnapshot });
  };
  const renderEvidence = async (request: RenderRequestV2) => {
    const root = request.stagingDirectory;
    const identity = { schemaVersion: 2, jobId: request.jobId, assetId: request.asset.assetId, attempt: request.attempt, operationId: request.operationId };
    const source = request.ownedInput.source; const dep = request.ownedInput.dependencies[0]!;
    const ownedInputProof = await writeProof(root, 'checks/owned-input-proof.json', { ...identity, sourceRootIdentity: request.ownedInput.sourceRootIdentity, openedSourceRelativePath: source.relativePath,
      source: entry(request.asset.source, source.relativePath, source.bytes), dependencies: [{ ...entry(dep.original, dep.relativePath, dep.bytes), identity: dep.identity, sourceKind: 'linked' }],
      observedLinks: [{ parentOwnedRelativePath: source.relativePath, childOwnedRelativePath: dep.relativePath, identity: dep.identity }], closureProof: request.ownedInput.closureProof });
    const template = request.profile.template;
    const templateClosureProof = await writeProof(root, 'checks/template-closure-proof.json', { ...identity, template, workingTemplateRelativePath: 'template/working.psd',
      closureEntries: [{ ...entry(template, 'template/working.psd', 20), identity: 'template-root', sourceKind: 'template' }], observedLinks: [], documentTrace: { relativePath: 'checks/document-trace.json', sha256: sha('trace') } });
    const releaseProof = await writeRelease(root, identity);
    return { ...readFixture<Record<string, unknown>>('render-evidence.v2.valid.json'), ...identity,
      profileSha256: request.profile.profileSha256, sourceSha256: request.asset.source.sha256, toolSchemaSha256: request.profile.toolSchemaSha256,
      ownedInputProof, templateClosureProof, releaseProof };
  };
  return { dir, repository, job, asset, addJob, outputRoot, sourceRoot, prepared, renderEvidence, writeRelease,
    workspace: (jobId: string) => join(output, '.ne-psd-staging', jobId, asset.assetId, '1') };
}

describe('V2 render runner', () => {
  it('hands off exact owned source and linked copies, verifies proofs, and persists safe state', async () => {
    const f = await fixture(); const job = f.addJob('owned-job');
    let renders = 0;
    const backend = { prepareOwnedInput: f.prepared, render: async (request: RenderRequestV2) => { renders++;
      expect(await readFile(join(request.stagingDirectory, request.ownedInput.source.relativePath))).toEqual(Buffer.from('source-contents'));
      expect(await readFile(join(request.stagingDirectory, request.ownedInput.dependencies[0]!.relativePath))).toEqual(Buffer.from('linked-contents'));
      return f.renderEvidence(request); } } as unknown as PhotoshopBackendV2;
    const runner = new RenderRunner({ repository: f.repository, backend, installationId: 'install-1', outputRoot: f.outputRoot, resolveSourceRoot: () => f.sourceRoot, renderBudgetBytes: 1024 });
    const result = await runner.render(job, f.asset, 1);
    expect(result.evidence.operationId).toBeTruthy(); expect(renders).toBe(1);
    expect(f.repository.pendingMutations('install-1')).toEqual([]);
  });

  it('blocks before workspace and DB effects when another runner owns the same installation', async () => {
    const f = await fixture(); const job = f.addJob('blocked-job');
    const serialization = BackendSerialization.forInstallation('install-2'); serialization.block();
    let prepares = 0;
    const backend = { prepareOwnedInput: async (request: PrepareRequestV2) => { prepares++; return f.prepared(request); } } as unknown as PhotoshopBackendV2;
    const runner = new RenderRunner({ repository: f.repository, backend, installationId: 'install-2', outputRoot: f.outputRoot, resolveSourceRoot: () => f.sourceRoot, renderBudgetBytes: 1024 });
    await expect(runner.render(job, f.asset, 1)).rejects.toMatchObject({ code: 'MUTATION_BLOCKED' });
    expect(prepares).toBe(0); expect(existsSync(f.workspace(job.jobId))).toBe(false);
    expect(f.repository.snapshot(job.jobId).assets[0]).toMatchObject({ status: 'queued', attempt: 0 });
  });

  it('keeps admission blocked when timed-out render settles late', async () => {
    const f = await fixture(); const firstJob = f.addJob('late-1'); const secondJob = f.addJob('late-2');
    let settle!: (value: any) => void; let renders = 0;
    const backend = { prepareOwnedInput: f.prepared, render: async () => { renders++; return new Promise((resolve) => { settle = resolve; }); }, recover: async () => ({ safe: false, released: false, releaseProof: null, evidencePaths: [] }) } as unknown as PhotoshopBackendV2;
    const options = { repository: f.repository, backend, installationId: 'install-3', outputRoot: f.outputRoot, resolveSourceRoot: () => f.sourceRoot, renderBudgetBytes: 1024, timeoutMs: 5 };
    await expect(new RenderRunner(options).render(firstJob, f.asset, 1)).rejects.toMatchObject({ code: 'AMBIGUOUS_STATE' });
    settle({}); await Promise.resolve();
    await expect(new RenderRunner(options).render(secondJob, f.asset, 1)).rejects.toMatchObject({ code: 'MUTATION_BLOCKED' });
    expect(renders).toBe(1); expect(existsSync(f.workspace(secondJob.jobId))).toBe(false);
  });

  it('rejects a second runner before preparation while the first render is busy', async () => {
    const f = await fixture(); const firstJob = f.addJob('busy-1'); const secondJob = f.addJob('busy-2');
    let started!: () => void; const entered = new Promise<void>((resolve) => { started = resolve; });
    let finish!: (value: any) => void; let prepares = 0;
    const backend = { prepareOwnedInput: async (request: PrepareRequestV2) => { prepares++; return f.prepared(request); },
      render: async () => { started(); return new Promise((resolve) => { finish = resolve; }); } } as unknown as PhotoshopBackendV2;
    const options = { repository: f.repository, backend, installationId: 'busy-install', outputRoot: f.outputRoot, resolveSourceRoot: () => f.sourceRoot, renderBudgetBytes: 1024 };
    const inFlight = new RenderRunner(options).render(firstJob, f.asset, 1);
    await entered;
    await expect(new RenderRunner(options).render(secondJob, f.asset, 1)).rejects.toMatchObject({ code: 'MUTATION_BLOCKED' });
    expect(prepares).toBe(1); expect(existsSync(f.workspace(secondJob.jobId))).toBe(false);
    // A late unproved result cannot make a second operation safe.
    finish({}); await expect(inFlight).rejects.toMatchObject({ code: 'AMBIGUOUS_STATE' });
  });

  it('retries only a transport failure after identity-bound positive recovery', async () => {
    const f = await fixture(); const job = f.addJob('retry-job'); let renders = 0; let active!: RenderRequestV2;
    const backend = { prepareOwnedInput: f.prepared,
      render: async (request: RenderRequestV2) => { active = request; renders++; if (renders === 1) throw Object.assign(new Error('transport'), { code: 'TRANSPORT_FAILURE' }); return f.renderEvidence(request); },
      recover: async (request: any) => { const releaseProof = await f.writeRelease(active.stagingDirectory, request); return { ...request, safe: true, released: true, releaseProof, evidencePaths: [releaseProof.relativePath] }; } } as unknown as PhotoshopBackendV2;
    const runner = new RenderRunner({ repository: f.repository, backend, installationId: 'retry-install', outputRoot: f.outputRoot, resolveSourceRoot: () => f.sourceRoot, renderBudgetBytes: 1024 });
    const result = await runner.renderWithRetry(job, f.asset);
    expect(result.evidence.attempt).toBe(2); expect(renders).toBe(2);
    expect(f.repository.pendingMutations('retry-install')).toEqual([]);
    expect(f.repository.snapshot(job.jobId).assets[0]).toMatchObject({ status: 'rendering', attempt: 2 });
  });

  it('does not spend an attempt or invoke retry when read-only preparation fails', async () => {
    const f = await fixture(); const job = f.addJob('prepare-fails'); let prepares = 0;
    const backend = { prepareOwnedInput: async () => { prepares++; throw Object.assign(new Error('transport unavailable'), { code: 'TRANSPORT_FAILURE' }); } } as unknown as PhotoshopBackendV2;
    const runner = new RenderRunner({ repository: f.repository, backend, installationId: 'prepare-install', outputRoot: f.outputRoot, resolveSourceRoot: () => f.sourceRoot, renderBudgetBytes: 1024 });
    await expect(runner.renderWithRetry(job, f.asset)).rejects.toMatchObject({ code: 'TRANSPORT_FAILURE' });
    expect(prepares).toBe(1);
    expect(f.repository.snapshot(job.jobId).assets[0]).toMatchObject({ status: 'queued', attempt: 0 });
  });

  it('uses a fresh owned generation after settled preparation failure and preserves diagnostics', async () => {
    const f = await fixture(); const job = f.addJob('resume-preparation');
    const staging: string[] = []; let prepares = 0;
    const backend = { prepareOwnedInput: async (request: PrepareRequestV2) => {
      staging.push(request.stagingDirectory); prepares++;
      if (prepares === 1) {
        await mkdir(join(request.stagingDirectory, 'checks'));
        await writeFile(join(request.stagingDirectory, 'checks/diagnostic.json'), 'first failure');
        throw Object.assign(new Error('read-only preparation failed'), { code: 'PREPARE_FAILED' });
      }
      return f.prepared(request);
    }, render: f.renderEvidence } as unknown as PhotoshopBackendV2;
    const options = { repository: f.repository, backend, installationId: 'resume-prep-install', outputRoot: f.outputRoot, resolveSourceRoot: () => f.sourceRoot, renderBudgetBytes: 1024 };
    await expect(new RenderRunner(options).render(job, f.asset, 1)).rejects.toMatchObject({ code: 'PREPARE_FAILED' });
    const result = await new RenderRunner(options).render(job, f.asset, 1);
    expect(staging).toHaveLength(2); expect(staging[1]).not.toBe(staging[0]);
    expect(result.workspace.root).toBe(staging[1]);
    expect(await readFile(join(staging[0]!, 'checks/diagnostic.json'), 'utf8')).toBe('first failure');
    expect(f.repository.snapshot(job.jobId).assets[0]).toMatchObject({ status: 'rendering', attempt: 1 });
  });

  it('does not remove or reuse a preparation workspace while its producer settles late', async () => {
    const f = await fixture(); const firstJob = f.addJob('late-prep-first'); const secondJob = f.addJob('late-prep-second');
    let entered!: () => void; const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    let finish!: () => void; const release = new Promise<void>((resolve) => { finish = resolve; });
    let firstStage = '';
    const backend = { prepareOwnedInput: async (request: PrepareRequestV2) => {
      firstStage = request.stagingDirectory; entered(); await release;
      await mkdir(join(firstStage, 'checks'));
      await writeFile(join(firstStage, 'checks/late.json'), 'late diagnostic');
      return f.prepared(request);
    }, render: f.renderEvidence } as unknown as PhotoshopBackendV2;
    const options = { repository: f.repository, backend, installationId: 'late-prep-install', outputRoot: f.outputRoot, resolveSourceRoot: () => f.sourceRoot, renderBudgetBytes: 1024 };
    const parent = new AbortController();
    const first = new RenderRunner(options).render(firstJob, f.asset, 1, parent.signal);
    await enteredPromise; parent.abort('cancel');
    await expect(new RenderRunner(options).render(secondJob, f.asset, 1)).rejects.toMatchObject({ code: 'MUTATION_IN_PROGRESS' });
    finish(); await expect(first).rejects.toMatchObject({ code: 'CONTROL_REQUESTED' });
    const lateStage = firstStage;
    expect(await readFile(join(lateStage, 'checks/late.json'), 'utf8')).toBe('late diagnostic');
    expect(f.repository.snapshot(firstJob.jobId).assets[0]).toMatchObject({ status: 'queued', attempt: 0 });
    const retry = await new RenderRunner(options).render(firstJob, f.asset, 1);
    expect(retry.workspace.root).not.toBe(lateStage);
    expect(await readFile(join(lateStage, 'checks/late.json'), 'utf8')).toBe('late diagnostic');
  });

  it('rejects source bytes changed after preparation before any render intent', async () => {
    const f = await fixture(); const job = f.addJob('source-drift'); let renders = 0;
    const backend = { prepareOwnedInput: async (request: PrepareRequestV2) => {
      const manifest = await f.prepared(request);
      await writeFile(join(f.sourceRoot.canonicalRoot, 'assets/source.png'), 'changed after scan');
      return manifest;
    }, render: async () => { renders++; return {}; } } as unknown as PhotoshopBackendV2;
    const runner = new RenderRunner({ repository: f.repository, backend, installationId: 'source-drift-install', outputRoot: f.outputRoot, resolveSourceRoot: () => f.sourceRoot, renderBudgetBytes: 1024 });
    await expect(runner.render(job, f.asset, 1)).rejects.toThrow(/digest|changed/i);
    expect(renders).toBe(0); expect(f.repository.snapshot(job.jobId).assets[0]).toMatchObject({ status: 'queued', attempt: 0 });
  });

  it('rejects source-root identity drift between preparation and copy', async () => {
    const f = await fixture(); const job = f.addJob('root-drift'); let renders = 0;
    const backend = { prepareOwnedInput: async (request: PrepareRequestV2) => {
      const manifest = await f.prepared(request);
      await rename(f.sourceRoot.canonicalRoot, join(f.dir, 'old-input'));
      await mkdir(join(f.sourceRoot.canonicalRoot, 'assets'), { recursive: true });
      await writeFile(join(f.sourceRoot.canonicalRoot, 'assets/source.png'), 'source-contents');
      await writeFile(join(f.sourceRoot.canonicalRoot, 'assets/linked.psb'), 'linked-contents');
      return manifest;
    }, render: async () => { renders++; return {}; } } as unknown as PhotoshopBackendV2;
    const runner = new RenderRunner({ repository: f.repository, backend, installationId: 'root-drift-install', outputRoot: f.outputRoot, resolveSourceRoot: () => f.sourceRoot, renderBudgetBytes: 1024 });
    await expect(runner.render(job, f.asset, 1)).rejects.toThrow(/root identity/i);
    expect(renders).toBe(0); expect(f.repository.snapshot(job.jobId).assets[0]).toMatchObject({ status: 'queued', attempt: 0 });
  });

  it('blocks replay after crash intent and rejects in-flight V1 attempts', async () => {
    const f = await fixture(); const job = f.addJob('crash-job');
    f.repository.beginV2Attempt(job.jobId, f.asset.assetId, 1, { installationId: 'crash-install', operationId: 'crashed-op', stagingDirectory: f.workspace(job.jobId), sourceRootIdentity: f.sourceRoot.canonicalRootIdentity });
    let prepares = 0;
    const backend = { prepareOwnedInput: async () => { prepares++; return {}; } } as unknown as PhotoshopBackendV2;
    const options = { repository: f.repository, backend, installationId: 'crash-install', outputRoot: f.outputRoot, resolveSourceRoot: () => f.sourceRoot, renderBudgetBytes: 1024 };
    await expect(new RenderRunner(options).render(job, f.asset, 1)).rejects.toMatchObject({ code: 'MUTATION_BLOCKED' });
    expect(prepares).toBe(0);
    const legacy = f.addJob('legacy-job'); f.repository.transition(legacy.jobId, f.asset.assetId, 'rendering');
    await expect(new RenderRunner({ ...options, installationId: 'another-install' }).render(legacy, f.asset, 1)).rejects.toMatchObject({ code: 'MUTATION_BLOCKED' });
  });

  it('honors pause and cancel before any Photoshop preparation', async () => {
    const f = await fixture(); const pauseJob = f.addJob('pause-job'); const cancelJob = f.addJob('cancel-job');
    let prepares = 0;
    const backend = { prepareOwnedInput: async () => { prepares++; return {}; } } as unknown as PhotoshopBackendV2;
    const options = { repository: f.repository, backend, installationId: 'control-install', outputRoot: f.outputRoot, resolveSourceRoot: () => f.sourceRoot, renderBudgetBytes: 1024 };
    f.repository.requestPause(pauseJob.jobId);
    await expect(new RenderRunner(options).render(pauseJob, f.asset, 1)).rejects.toMatchObject({ code: 'PAUSED' });
    f.repository.requestCancel(cancelJob.jobId);
    await expect(new RenderRunner(options).render(cancelJob, f.asset, 1)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(prepares).toBe(0); expect(existsSync(f.workspace(pauseJob.jobId))).toBe(false); expect(existsSync(f.workspace(cancelJob.jobId))).toBe(false);
  });

  it('holds admission during recovery and clears it only after release proof bytes validate', async () => {
    const f = await fixture(); const firstJob = f.addJob('recover-first'); const secondJob = f.addJob('recover-second');
    let active!: RenderRequestV2; let recoveryStarted!: () => void; let finishRecovery!: () => void; let renders = 0;
    const enteredRecovery = new Promise<void>((resolve) => { recoveryStarted = resolve; });
    const backend = { prepareOwnedInput: f.prepared,
      render: async (request: RenderRequestV2) => { renders++; active = request; if (renders === 1) throw Object.assign(new Error('uncertain save'), { code: 'AMBIGUOUS_STATE' }); return f.renderEvidence(request); },
      recover: async (request: any) => { recoveryStarted(); await new Promise<void>((resolve) => { finishRecovery = resolve; });
        const releaseProof = await f.writeRelease(active.stagingDirectory, request); return { ...request, safe: true, released: true, releaseProof, evidencePaths: [releaseProof.relativePath] }; } } as unknown as PhotoshopBackendV2;
    const options = { repository: f.repository, backend, installationId: 'recover-install', outputRoot: f.outputRoot, resolveSourceRoot: () => f.sourceRoot, renderBudgetBytes: 1024 };
    const recovering = new RenderRunner(options).render(firstJob, f.asset, 1);
    await enteredRecovery;
    await expect(new RenderRunner(options).render(secondJob, f.asset, 1)).rejects.toMatchObject({ code: 'MUTATION_BLOCKED' });
    expect(existsSync(f.workspace(secondJob.jobId))).toBe(false);
    finishRecovery(); await expect(recovering).rejects.toMatchObject({ code: 'AMBIGUOUS_RECOVERED' });
    await expect(new RenderRunner(options).render(secondJob, f.asset, 1)).resolves.toBeTruthy();
    expect(renders).toBe(2);
  });

  it('rejects a safe recovery claim with missing release snapshot bytes', async () => {
    const f = await fixture(); const firstJob = f.addJob('unproven-first'); const secondJob = f.addJob('unproven-second');
    let active!: RenderRequestV2;
    const backend = { prepareOwnedInput: f.prepared, render: async (request: RenderRequestV2) => { active = request; throw Object.assign(new Error('uncertain'), { code: 'AMBIGUOUS_STATE' }); },
      recover: async (request: any) => { const releaseProof = await f.writeRelease(active.stagingDirectory, request);
        await rm(join(active.stagingDirectory, 'checks/release-owner.json'));
        return { ...request, safe: true, released: true, releaseProof, evidencePaths: [releaseProof.relativePath] }; } } as unknown as PhotoshopBackendV2;
    const options = { repository: f.repository, backend, installationId: 'unproven-install', outputRoot: f.outputRoot, resolveSourceRoot: () => f.sourceRoot, renderBudgetBytes: 1024 };
    await expect(new RenderRunner(options).render(firstJob, f.asset, 1)).rejects.toMatchObject({ code: 'AMBIGUOUS_STATE' });
    await expect(new RenderRunner(options).render(secondJob, f.asset, 1)).rejects.toMatchObject({ code: 'MUTATION_BLOCKED' });
    expect(f.repository.snapshot(firstJob.jobId).assets[0]).toMatchObject({ status: 'blocked', attempt: 1 });
  });

  it('reconciles a persisted blocked attempt after restart without replaying it', async () => {
    const f = await fixture(); const firstJob = f.addJob('restart-first'); const nextJob = f.addJob('restart-next');
    const workspace = await createAttemptWorkspace(f.outputRoot.canonicalRoot, firstJob.jobId, f.asset.assetId, 1, 'restart-op');
    f.repository.beginV2Attempt(firstJob.jobId, f.asset.assetId, 1, { installationId: 'restart-install', operationId: 'restart-op', stagingDirectory: workspace.root, sourceRootIdentity: f.sourceRoot.canonicalRootIdentity });
    f.repository.markV2Ambiguous(firstJob.jobId, f.asset.assetId, 1, 'restart-op');
    f.repository.transition(firstJob.jobId, f.asset.assetId, 'blocked', { code: 'AMBIGUOUS_STATE', category: 'ambiguousState', message: 'crash', retryable: false, evidencePaths: [] });
    const backend = { prepareOwnedInput: f.prepared, render: f.renderEvidence,
      recover: async (request: any) => { const releaseProof = await f.writeRelease(workspace.root, request);
        return { ...request, safe: true, released: true, releaseProof, evidencePaths: [releaseProof.relativePath] }; } } as unknown as PhotoshopBackendV2;
    const options = { repository: f.repository, backend, installationId: 'restart-install', outputRoot: f.outputRoot, resolveSourceRoot: () => f.sourceRoot, renderBudgetBytes: 1024 };
    const runner = new RenderRunner(options);
    expect(await runner.recoverPending()).toBe(1);
    expect(f.repository.pendingMutations('restart-install')).toEqual([]);
    await expect(new RenderRunner(options).render(nextJob, f.asset, 1)).resolves.toBeTruthy();
    expect(f.repository.snapshot(firstJob.jobId).assets[0]).toMatchObject({ status: 'blocked', attempt: 1 });
  });
});
