import type { PhotoshopBackend, RenderEvidence, RenderRequest, JobSpec, Asset } from '@ne-psd/contracts';
import type { JobRepository, OutputRootBinding } from './job-repository.js';
import { createAttemptWorkspace, cleanupAttemptWorkspace, copyValidatedSource, type AttemptWorkspace } from './attempt-workspace.js';
import type { PreflightFile } from './preflight.js';
import { createOperationCancellation } from './cancellation.js';
import { recoverReadOnly, isAmbiguousMutationError, isRetryableTransportError } from './recovery.js';
import { BackendSerialization } from './backend-serialization.js';
import type { PhotoshopLease } from './backend-serialization.js';
import { mayRetryAttempt } from './retry-policy.js';

export type RenderRunnerOptions = { repository: JobRepository; backend: PhotoshopBackend; lease: PhotoshopLease; outputRoot: OutputRootBinding; timeoutMs?: number; serialization?: BackendSerialization; source?: PreflightFile };
export type RenderAttemptResult = { evidence: RenderEvidence; workspace: AttemptWorkspace };

export class RenderRunner {
  private readonly serialization: BackendSerialization;
  constructor(private readonly options: RenderRunnerOptions) { this.serialization = options.serialization ?? BackendSerialization.forLease(options.lease); }
  async render(job: JobSpec, asset: Asset, attempt: 1 | 2, parentSignal?: AbortSignal): Promise<RenderAttemptResult> {
    return this.serialization.run(() => this.renderAdmitted(job, asset, attempt, parentSignal));
  }
  private async renderAdmitted(job: JobSpec, asset: Asset, attempt: 1 | 2, parentSignal?: AbortSignal): Promise<RenderAttemptResult> {
    const workspace = await createAttemptWorkspace(this.options.outputRoot.canonicalRoot, job.jobId, asset.assetId, attempt);
    await this.options.lease.acquire(job.jobId);
    const cancellation = createOperationCancellation(this.options.timeoutMs ?? 120_000, parentSignal);
    try {
      try {
        const diagnostics = await this.options.lease.diagnostics();
        if (diagnostics.jobId !== job.jobId || !diagnostics.host || diagnostics.pid <= 0 || !diagnostics.processStart) throw Object.assign(new Error('Photoshop lease diagnostics do not identify the active job'), { code: 'LEASE_DIAGNOSTICS_INVALID' });
        if (this.options.source) await copyValidatedSource(workspace, this.options.source);
        this.options.repository.transition(job.jobId, asset.assetId, 'rendering');
      } catch (error) {
        if (!await this.releaseIfProvenSafe()) { this.serialization.block(); await this.retainLease(); }
        throw error;
      }

      const request: RenderRequest = { schemaVersion: 1, jobId: job.jobId, asset, profile: job.profile, attempt, stagingDirectory: workspace.root };
      let evidence: RenderEvidence;
      try {
        const render = this.options.backend.render(request, cancellation.signal);
        const timeout = cancellation.deadline.then(() => { throw Object.assign(new Error('render operation timed out'), { code: 'AMBIGUOUS_STATE' }); });
        evidence = await Promise.race([render, timeout]);
      } catch (error) {
        if (isAmbiguousMutationError(error) || cancellation.timedOut()) {
          this.serialization.block();
          await this.retainLease();
          const recovery = await recoverReadOnly(this.options.backend, job.jobId, new AbortController().signal);
          if (recovery.safe && await this.releaseIfProvenSafe()) {
            this.options.repository.transition(job.jobId, asset.assetId, 'failed', { code: 'AMBIGUOUS_RECOVERED', category: 'ambiguousState', message: 'render ended ambiguously but recovery proved safe', retryable: false, evidencePaths: recovery.evidencePaths });
            this.serialization.clearBlocked();
            throw Object.assign(new Error('render ended ambiguously but recovery proved safe'), { code: 'AMBIGUOUS_RECOVERED', cause: error });
          }
          await this.retainLease();
          this.blockAsset(job, asset, recovery.evidencePaths);
          throw Object.assign(new Error('render mutation state is ambiguous'), { code: 'AMBIGUOUS_STATE', cause: error });
        }
        if (!await this.releaseIfProvenSafe()) {
          this.serialization.block();
          await this.retainLease();
          this.blockAsset(job, asset, []);
          throw Object.assign(new Error('Photoshop lease release could not be proven safe'), { code: 'AMBIGUOUS_STATE', cause: error });
        }
        this.options.repository.transition(job.jobId, asset.assetId, 'failed', { code: (error as { code?: string })?.code ?? 'RENDER_FAILED', category: 'transient', message: error instanceof Error ? error.message : 'render failed', retryable: isRetryableTransportError(error), evidencePaths: [] });
        throw error;
      }
      if (!await this.releaseIfProvenSafe()) {
        this.serialization.block();
        await this.retainLease();
        this.blockAsset(job, asset, []);
        throw Object.assign(new Error('Photoshop lease release could not be proven safe'), { code: 'AMBIGUOUS_STATE' });
      }
      return { evidence, workspace };
    } finally {
      cancellation.dispose();
    }
  }
  private async releaseIfProvenSafe(): Promise<boolean> {
    try {
      if (!this.options.lease.safeToRelease || await this.options.lease.safeToRelease() !== true) return false;
      await this.options.lease.release();
      return true;
    } catch { return false; }
  }
  private async retainLease(): Promise<void> { try { await this.options.lease.retain(); } catch { /* the admission barrier remains set */ } }
  private blockAsset(job: JobSpec, asset: Asset, evidencePaths: string[]): void {
    this.options.repository.transition(job.jobId, asset.assetId, 'blocked', { code: 'AMBIGUOUS_STATE', category: 'ambiguousState', message: 'Photoshop mutation state could not be proven safe', retryable: false, evidencePaths });
  }
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
