import { randomUUID } from 'node:crypto';
import { realpath, statfs } from 'node:fs/promises';
import { extname } from 'node:path';
import {
  validatePreparedInputManifestV2, validateRenderRequestV2, validateRenderEvidenceV2,
  validateRecoveryResultV2, validateOwnedInputProofV2, validateTemplateClosureProofV2,
  validateReleaseProofV2,
  AssetSchema, JobSpecSchema, sha256Json,
} from '@ne-psd/contracts';
import type { Asset, JobSpec, PhotoshopBackendV2, PreparedInputManifestV2, RenderEvidenceV2, RenderRequestV2, RecoveryRequestV2 } from '@ne-psd/contracts';
import type { JobRepository, OutputRootBinding } from './job-repository.js';
import { filesystemIdentity } from './job-repository.js';
import { createAttemptWorkspace, copyOwnedFile, verifyWorkspaceFile, type AttemptWorkspace, type TrustedSourceRoot } from './attempt-workspace.js';
import { createOperationCancellation } from './cancellation.js';
import { BackendSerialization } from './backend-serialization.js';
import { isRetryableTransportError } from './recovery.js';
import { mayRetryAttempt } from './retry-policy.js';

export type RenderRunnerOptions = {
  repository: JobRepository;
  backend: PhotoshopBackendV2;
  installationId: string;
  outputRoot: OutputRootBinding;
  resolveSourceRoot(rootId: string): TrustedSourceRoot | Promise<TrustedSourceRoot>;
  renderBudgetBytes: number;
  timeoutMs?: number;
  serialization?: BackendSerialization;
};
export type RenderAttemptResult = { request: RenderRequestV2; evidence: RenderEvidenceV2; workspace: AttemptWorkspace };
type ProofRef = { relativePath: string; sha256: string };
const coded = (code: string, message: string, cause?: unknown) => Object.assign(new Error(message), { code, cause });
const identity = (request: { jobId: string; assetId?: string; asset?: Asset; attempt: 1 | 2; operationId: string }) => ({
  schemaVersion: 2 as const, jobId: request.jobId, assetId: request.assetId ?? request.asset!.assetId, attempt: request.attempt, operationId: request.operationId,
});

export class RenderRunner {
  private readonly serialization: BackendSerialization;
  constructor(private readonly options: RenderRunnerOptions) {
    if (!options.installationId || !Number.isSafeInteger(options.renderBudgetBytes) || options.renderBudgetBytes < 1) throw new Error('trusted installation and measured render disk budget required');
    this.serialization = options.serialization ?? BackendSerialization.forInstallation(options.installationId);
    if (options.repository.pendingMutations(options.installationId).length > 0) this.serialization.block();
  }

  async render(job: JobSpec, asset: Asset, attempt: 1 | 2, parentSignal?: AbortSignal): Promise<RenderAttemptResult> {
    return this.serialization.run(() => this.renderAdmitted(job, asset, attempt, parentSignal));
  }

  private async renderAdmitted(job: JobSpec, asset: Asset, attempt: 1 | 2, parentSignal?: AbortSignal): Promise<RenderAttemptResult> {
    job = JobSpecSchema.parse(job);
    asset = AssetSchema.parse(asset);
    const stored = this.options.repository.getJobSpec(job.jobId);
    const selected = stored.assets.find((entry) => entry.assetId === asset.assetId);
    if (!selected || sha256Json(job) !== sha256Json(stored) || sha256Json(asset) !== sha256Json(selected)) {
      throw coded('JOB_BINDING_MISMATCH', 'render input differs from persisted job and selected asset');
    }
    if (this.options.repository.pendingMutations(this.options.installationId).length) {
      this.serialization.block();
      throw coded('MUTATION_BLOCKED', 'unresolved Photoshop attempt requires recovery');
    }
    const control = this.options.repository.controlState(job.jobId);
    if (control === 'pause') { this.options.repository.acknowledgePause(job.jobId); throw coded('PAUSED', 'job paused before mutation'); }
    if (control === 'cancel') { this.options.repository.acknowledgeCancel(job.jobId); throw coded('CANCELLED', 'job cancelled before mutation'); }
    if (parentSignal?.aborted) throw coded('CANCELLED', 'render cancelled before mutation');
    const sourceRoot = await this.trustedRoot(asset.source.rootId);
    if (asset.source.rootId !== sourceRoot.rootId) throw coded('SOURCE_ROOT_BINDING_MISMATCH', 'selected source root does not match trusted mapping');
    const operationId = randomUUID();
    const workspace = await createAttemptWorkspace(this.options.outputRoot.canonicalRoot, job.jobId, asset.assetId, attempt, operationId);
    if (workspace.outputRootIdentity !== this.options.outputRoot.canonicalRootIdentity) throw coded('OUTPUT_ROOT_BINDING_MISMATCH', 'output root changed before attempt');
    const prepareRequest = {
      schemaVersion: 2 as const, jobId: job.jobId, asset, profile: job.profile, attempt,
      operationId, stagingDirectory: workspace.root, scratchDirectory: 'scratch',
      sourceRoot: { rootId: sourceRoot.rootId, path: sourceRoot.canonicalRoot, identity: sourceRoot.canonicalRootIdentity },
    };
    const dispatchedPrepare = structuredClone(prepareRequest);
    const preparedRaw = await this.options.backend.prepareOwnedInput(dispatchedPrepare, parentSignal ?? new AbortController().signal);
    if (sha256Json(dispatchedPrepare) !== sha256Json(prepareRequest)) throw coded('PREPARE_REQUEST_MUTATED', 'backend changed the preparation request');
    const checked = validatePreparedInputManifestV2(preparedRaw, prepareRequest);
    if (!checked.success) throw coded('PREPARED_INPUT_INVALID', 'Photoshop prepared input manifest is invalid', checked.error);
    const prepared = checked.data;
    if (prepared.status === 'blocked') throw coded('PREPARED_INPUT_BLOCKED', 'Photoshop could not establish complete linked input closure');
    await verifyWorkspaceFile(workspace, prepared.closureProof.relativePath, prepared.closureProof.sha256);
    await this.checkDiskBudget(workspace, prepared);
    const sourcePath = `scratch/input/source${extname(asset.source.relativePath)}`;
    await copyOwnedFile(workspace, sourceRoot, prepared.source.original, prepared.source.bytes, sourcePath);
    const dependencies = [];
    for (const [index, dependency] of prepared.dependencies.entries()) {
      const root = await this.trustedRoot(dependency.original.rootId);
      const relativePath = `scratch/input/dependency-${index}${extname(dependency.original.relativePath)}`;
      await copyOwnedFile(workspace, root, dependency.original, dependency.bytes, relativePath);
      dependencies.push({ identity: dependency.identity, original: dependency.original, sourceKind: 'linked' as const,
        relativePath, sha256: dependency.original.sha256, bytes: dependency.bytes });
    }
    const request: RenderRequestV2 = {
      schemaVersion: 2, jobId: job.jobId, asset, profile: job.profile, attempt, stagingDirectory: workspace.root, operationId,
      ownedInput: { scratchDirectory: 'scratch', sourceRootIdentity: sourceRoot.canonicalRootIdentity,
        source: { relativePath: sourcePath, sha256: asset.source.sha256, bytes: asset.sourceBytes }, dependencies, closureProof: prepared.closureProof },
    };
    const validatedRequest = validateRenderRequestV2(request, prepared);
    if (!validatedRequest.success) throw coded('RENDER_REQUEST_INVALID', 'owned render request differs from prepared input', validatedRequest.error);
    const requestSnapshot = structuredClone(validatedRequest.data);
    if (parentSignal?.aborted || this.options.repository.controlState(job.jobId) !== null) throw coded('CONTROL_REQUESTED', 'job control changed before mutation dispatch');
    this.options.repository.beginV2Attempt(job.jobId, asset.assetId, attempt, {
      installationId: this.options.installationId, operationId, stagingDirectory: workspace.root, sourceRootIdentity: sourceRoot.canonicalRootIdentity,
    });
    this.options.repository.markV2Dispatched(job.jobId, asset.assetId, attempt, operationId);
    const cancellation = createOperationCancellation(this.options.timeoutMs ?? 120_000, parentSignal);
    try {
      const dispatchedRender = structuredClone(requestSnapshot);
      const render = this.options.backend.render(dispatchedRender, cancellation.signal);
      const timeout = cancellation.deadline.then(() => { throw coded('AMBIGUOUS_STATE', 'render deadline elapsed'); });
      const raw = await Promise.race([render, timeout]);
      if (sha256Json(dispatchedRender) !== sha256Json(requestSnapshot)) throw coded('RENDER_REQUEST_MUTATED', 'backend changed the render request');
      const validated = validateRenderEvidenceV2(raw, requestSnapshot);
      if (!validated.success) throw coded('RENDER_EVIDENCE_INVALID', 'render evidence identity or shape invalid', validated.error);
      await this.verifyRenderProofs(workspace, requestSnapshot, prepared, validated.data);
      this.options.repository.markV2Safe(job.jobId, asset.assetId, attempt, operationId);
      this.serialization.clearBlocked();
      const after = this.options.repository.controlState(job.jobId);
      if (after === 'pause') this.options.repository.acknowledgePause(job.jobId);
      if (after === 'cancel') this.options.repository.acknowledgeCancel(job.jobId);
      return { request: requestSnapshot, evidence: validated.data, workspace };
    } catch (error) {
      this.serialization.block();
      this.options.repository.markV2Ambiguous(job.jobId, asset.assetId, attempt, operationId);
      const recovered = await this.recoverOne(identity(request), workspace);
      if (recovered) {
        this.options.repository.markV2Safe(job.jobId, asset.assetId, attempt, operationId);
        this.serialization.clearBlocked();
        const retryable = isRetryableTransportError(error) && !cancellation.timedOut();
        this.options.repository.transition(job.jobId, asset.assetId, 'failed', { code: retryable ? 'TRANSPORT_FAILURE' : 'AMBIGUOUS_RECOVERED', category: retryable ? 'transient' : 'ambiguousState', message: 'render failed; Photoshop recovery proved release', retryable, evidencePaths: [] });
        if (retryable) throw error;
        throw coded('AMBIGUOUS_RECOVERED', 'render failed after proven safe recovery', error);
      }
      this.options.repository.transition(job.jobId, asset.assetId, 'blocked', { code: 'AMBIGUOUS_STATE', category: 'ambiguousState', message: 'Photoshop mutation or release remains unproven', retryable: false, evidencePaths: [] });
      throw coded('AMBIGUOUS_STATE', 'Photoshop mutation state remains unproven', error);
    } finally { cancellation.dispose(); }
  }

  private async trustedRoot(rootId: string): Promise<TrustedSourceRoot> {
    const root = await this.options.resolveSourceRoot(rootId);
    if (!root || root.rootId !== rootId || await realpath(root.canonicalRoot) !== root.canonicalRoot || filesystemIdentity(root.canonicalRoot) !== root.canonicalRootIdentity) throw coded('SOURCE_ROOT_BINDING_MISMATCH', 'trusted source root changed');
    return root;
  }
  private async checkDiskBudget(workspace: AttemptWorkspace, manifest: Extract<PreparedInputManifestV2, { status: 'prepared' }>): Promise<void> {
    const space = await statfs(workspace.root);
    const available = BigInt(space.bavail) * BigInt(space.bsize);
    const required = BigInt(this.options.renderBudgetBytes) + BigInt(manifest.source.bytes) + manifest.dependencies.reduce((sum, entry) => sum + BigInt(entry.bytes), 0n);
    if (available < required) throw coded('DISK_BUDGET_INSUFFICIENT', 'measured free space is below owned-copy and render budget');
  }
  private async proofJson(workspace: AttemptWorkspace, ref: ProofRef): Promise<unknown> {
    const bytes = await verifyWorkspaceFile(workspace, ref.relativePath, ref.sha256);
    try { return JSON.parse(bytes.toString('utf8')) as unknown; }
    catch { throw coded('PROOF_INVALID', 'proof file is not JSON'); }
  }
  private async verifyRelease(workspace: AttemptWorkspace, ref: ProofRef, expected: RecoveryRequestV2): Promise<void> {
    const checked = validateReleaseProofV2(await this.proofJson(workspace, ref), expected);
    if (!checked.success) throw coded('RELEASE_PROOF_INVALID', 'release proof identity invalid', checked.error);
    await verifyWorkspaceFile(workspace, checked.data.ownerSnapshot.relativePath, checked.data.ownerSnapshot.sha256);
    await verifyWorkspaceFile(workspace, checked.data.journalSnapshot.relativePath, checked.data.journalSnapshot.sha256);
  }
  private async verifyRenderProofs(workspace: AttemptWorkspace, request: RenderRequestV2, manifest: PreparedInputManifestV2, evidence: RenderEvidenceV2): Promise<void> {
    const owned = validateOwnedInputProofV2(await this.proofJson(workspace, evidence.ownedInputProof), request, manifest);
    if (!owned.success) throw coded('OWNED_INPUT_PROOF_INVALID', 'owned input proof mismatch', owned.error);
    const template = validateTemplateClosureProofV2(await this.proofJson(workspace, evidence.templateClosureProof), request);
    if (!template.success) throw coded('TEMPLATE_PROOF_INVALID', 'template closure proof mismatch', template.error);
    for (const entry of [owned.data.source, ...owned.data.dependencies]) await verifyWorkspaceFile(workspace, entry.ownedRelativePath, entry.copyAfterSha256);
    await this.verifyRelease(workspace, evidence.releaseProof, identity(request));
  }
  private async recoverOne(request: RecoveryRequestV2, workspace: AttemptWorkspace): Promise<boolean> {
    try {
      const raw = await this.options.backend.recover(request, new AbortController().signal);
      const checked = validateRecoveryResultV2(raw, request);
      if (!checked.success || !checked.data.safe || !checked.data.releaseProof) return false;
      await this.verifyRelease(workspace, checked.data.releaseProof, request);
      return true;
    } catch { return false; }
  }
  async recoverPending(): Promise<number> {
    return this.serialization.runRecovery(async () => {
      const pending = this.options.repository.pendingMutations(this.options.installationId);
      if (pending.some((item) => item.schemaVersion === 1)) throw coded('LEGACY_RECOVERY_REQUIRED', 'legacy in-flight attempt has no V2 identity; operator recovery required');
      let safe = 0;
      for (const item of pending) {
        if (!item.operationId || !item.stagingDirectory) continue;
        const root = item.stagingDirectory;
        const workspace: AttemptWorkspace = { root, outputRoot: this.options.outputRoot.canonicalRoot, outputRootIdentity: this.options.outputRoot.canonicalRootIdentity, rootIdentity: filesystemIdentity(root), recordedPaths: [root] };
        const request: RecoveryRequestV2 = { schemaVersion: 2, jobId: item.jobId, assetId: item.assetId, attempt: item.attempt as 1 | 2, operationId: item.operationId };
        if (!await this.recoverOne(request, workspace)) continue;
        this.options.repository.markV2Safe(item.jobId, item.assetId, item.attempt, item.operationId);
        if (this.options.repository.snapshot(item.jobId).assets.find((asset) => asset.assetId === item.assetId)?.status === 'rendering') {
          this.options.repository.transition(item.jobId, item.assetId, 'blocked', { code: 'AMBIGUOUS_RECOVERED', category: 'ambiguousState', message: 'recovered attempt requires fresh decision before replay', retryable: false, evidencePaths: [] });
        }
        safe++;
      }
      if (this.options.repository.pendingMutations(this.options.installationId).length === 0) this.serialization.clearBlocked();
      return safe;
    });
  }
  async renderWithRetry(job: JobSpec, asset: Asset, parentSignal?: AbortSignal): Promise<RenderAttemptResult> {
    for (const attempt of [1, 2] as const) {
      try { return await this.render(job, asset, attempt, parentSignal); }
      catch (error) {
        const current = this.options.repository.snapshot(job.jobId).assets.find((entry) => entry.assetId === asset.assetId);
        if (!mayRetryAttempt(error, attempt) || current?.status !== 'failed' || current.attempt !== attempt) throw error;
        this.options.repository.transition(job.jobId, asset.assetId, 'queued');
      }
    }
    throw coded('ATTEMPT_LIMIT', 'automatic render retry exhausted');
  }
}
