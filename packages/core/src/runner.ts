import type { PhotoshopBackend, RenderEvidence, RenderRequest, JobSpec, Asset } from '@ne-psd/contracts';
import type { JobRepository, OutputRootBinding } from './job-repository.js';
import { createAttemptWorkspace, cleanupAttemptWorkspace, copyValidatedSource, type AttemptWorkspace } from './attempt-workspace.js';
import type { PreflightFile } from './preflight.js';
import { createOperationCancellation } from './cancellation.js';
import { recoverReadOnly, isAmbiguousMutationError } from './recovery.js';
import { BackendSerialization } from './backend-serialization.js';
import type { PhotoshopLease } from './backend-serialization.js';
import { mayRetryAttempt } from './retry-policy.js';

export type RenderRunnerOptions = { repository: JobRepository; backend: PhotoshopBackend; lease: PhotoshopLease; outputRoot: OutputRootBinding; timeoutMs?: number; serialization?: BackendSerialization; source?: PreflightFile };
export type RenderAttemptResult = { evidence: RenderEvidence; workspace: AttemptWorkspace };

export class RenderRunner {
  private readonly serialization: BackendSerialization;
  constructor(private readonly options: RenderRunnerOptions) { this.serialization = options.serialization ?? BackendSerialization.forLease(options.lease); }
  async render(job: JobSpec, asset: Asset, attempt: 1 | 2, parentSignal?: AbortSignal): Promise<RenderAttemptResult> {
    const workspace = await createAttemptWorkspace(this.options.outputRoot.canonicalRoot, job.jobId, asset.assetId, attempt);
    const cancellation = createOperationCancellation(this.options.timeoutMs ?? 120_000, parentSignal);
    let acquired = false;
    await this.options.lease.acquire(job.jobId); acquired = true;
    try {
      const diagnostics = await this.options.lease.diagnostics();
      if (diagnostics.jobId !== job.jobId || !diagnostics.host || diagnostics.pid <= 0 || !diagnostics.processStart) throw Object.assign(new Error('Photoshop lease diagnostics do not identify the active job'), { code: 'LEASE_DIAGNOSTICS_INVALID' });
      if (this.options.source) await copyValidatedSource(workspace, this.options.source);
      this.options.repository.transition(job.jobId, asset.assetId, 'rendering');
    } catch (error) { if (acquired) await this.options.lease.retain(); cancellation.dispose(); throw error; }
    const request: RenderRequest = { schemaVersion: 1, jobId: job.jobId, asset, profile: job.profile, attempt, stagingDirectory: workspace.root };
    let settled = false;
    try {
      const render = this.serialization.run(() => this.options.backend.render(request, cancellation.signal));
      const timeout = cancellation.deadline.then(() => { throw Object.assign(new Error('render operation timed out'), { code: 'AMBIGUOUS_STATE' }); });
      const evidence = await Promise.race([render, timeout]);
      settled = true;
      await this.releaseIfSafe();
      return { evidence, workspace };
    } catch (error) {
      if (isAmbiguousMutationError(error) || cancellation.timedOut()) {
        await this.options.lease.retain();
        const recovery = await recoverReadOnly(this.options.backend, job.jobId, new AbortController().signal);
        if (recovery.safe) { this.serialization.clearBlocked(); await this.releaseIfSafe(); }
        else { this.serialization.block(); this.options.repository.transition(job.jobId, asset.assetId, 'blocked', { code: 'AMBIGUOUS_STATE', category: 'ambiguousState', message: 'Photoshop mutation state could not be proven safe', retryable: false, evidencePaths: recovery.evidencePaths }); }
        throw Object.assign(new Error(recovery.safe ? 'render ended ambiguously but recovery proved safe' : 'render mutation state is ambiguous'), { code: recovery.safe ? 'AMBIGUOUS_RECOVERED' : 'AMBIGUOUS_STATE', cause: error });
      }
      await this.releaseIfSafe();
      this.options.repository.transition(job.jobId, asset.assetId, 'failed', { code: (error as { code?: string })?.code ?? 'RENDER_FAILED', category: 'transient', message: error instanceof Error ? error.message : 'render failed', retryable: true, evidencePaths: [] });
      throw error;
    } finally {
      if (settled) cancellation.cancel('complete');
      cancellation.dispose();
    }
  }
  private async releaseIfSafe(): Promise<void> { const lease = this.options.lease as PhotoshopLease & { safeToRelease?: () => Promise<boolean> }; if (lease.safeToRelease && await lease.safeToRelease()) await lease.release(); else await lease.retain(); }
  async renderWithRetry(job: JobSpec, asset: Asset, parentSignal?: AbortSignal): Promise<RenderAttemptResult> {
    for (const attempt of [1, 2] as const) {
      try { return await this.render(job, asset, attempt, parentSignal); }
      catch (error) {
        if (!mayRetryAttempt(error, attempt)) throw error;
        this.options.repository.transition(job.jobId, asset.assetId, 'queued');
      }
    }
    throw new Error('render retry exhausted');
  }
  async cleanup(workspace: AttemptWorkspace): Promise<void> { await cleanupAttemptWorkspace(workspace); }
}
