import { access, mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  CapabilityReportSchema,
  InspectionReportSchema,
  QualificationResultSchema,
  RenderEvidenceSchema,
  RenderRequestSchema,
  type CapabilityReport,
  type DomainError,
  type InspectionReport,
  type QualificationRequest,
  type QualificationResult,
  type RenderEvidence,
  type RenderRequest,
} from '@ne-psd/contracts';
import { exportVariants, type ExportAdapter, type ExportResult, type QualityEvidence, type Rgb } from './export.js';
import { qualify as qualifyTemplate, type QualificationAdapter, type QualificationOptions } from './qualification.js';
import type { SessionLock } from './session-lock.js';
import type { FitMode, LayerSelector } from './types.js';

export type BackendLock = Pick<SessionLock, 'runExclusive'> & Partial<Pick<SessionLock, 'markUnknownMutation'>>;

export type RenderResource = {
  resourceId: string;
  target: LayerSelector;
  reference: LayerSelector;
  input: LayerSelector | null;
};

export type RenderPlacement = {
  target?: LayerSelector;
  reference: { left: number; top: number; right: number; bottom: number };
  placed: { left: number; top: number; right: number; bottom: number };
  fitMode: FitMode;
  clipped: boolean;
  adjacentToReference: boolean;
  evidencePaths?: readonly string[];
};

/** A job-owned transaction. Methods after createWorkingCopy are ordered by render(). */
export type RenderSession = {
  bundleRoot?: string;
  workingTemplatePath: string;
  resources: readonly RenderResource[];
  openRoot: () => Promise<unknown>;
  verifyGraph: (request: RenderRequest) => Promise<unknown>;
  renderResource: (resource: RenderResource, input: RenderRequest['asset'], fitMode: FitMode, signal: AbortSignal) => Promise<RenderPlacement>;
  verifyPropagation: (resources: readonly RenderResource[], signal: AbortSignal) => Promise<unknown>;
  exporter: ExportAdapter;
  jpegBackground?: Rgb;
  renderingIntent?: 'relative-colorimetric' | 'perceptual' | 'absolute-colorimetric' | 'saturation';
  qualityEvidence?: QualityEvidence;
  verifyOriginals: () => Promise<boolean>;
  discard: () => Promise<unknown>;
  documentTracePath?: string;
  toolTracePath?: string;
  evidencePaths?: readonly string[];
};

export type BackendAdapter = {
  lock: BackendLock;
  capabilities: (signal: AbortSignal) => Promise<unknown>;
  inspect: (templatePath: string, signal: AbortSignal) => Promise<unknown>;
  createWorkingCopy: (request: RenderRequest, signal: AbortSignal) => Promise<RenderSession>;
  qualification?: {
    adapter: QualificationAdapter;
    approvedCapability: true;
    approvedTemplateRoots: readonly string[];
    approvedEvidenceRoots: readonly string[];
  };
  recover?: (jobId: string, signal: AbortSignal) => Promise<{ safe: boolean; evidencePaths: string[] }>;
};

export type BackendOptions = BackendAdapter;

export class BackendError extends Error {
  readonly name = 'BackendError';
  constructor(
    readonly code: string,
    message: string,
    readonly category: DomainError['category'] = 'validation',
    readonly evidencePaths: readonly string[] = [],
  ) {
    super(message);
  }
}

const ABORT_CODE = 'CANCELLED';
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';
const checkpoint = (signal: AbortSignal): void => {
  if (signal.aborted) throw new BackendError(ABORT_CODE, 'render cancelled at a safe boundary', 'cancelled');
};
const digest = (value: unknown): string => JSON.stringify(value, (_key, item) => item === undefined ? null : item);

function relativeEvidence(root: string, path: string): string {
  if (!isAbsolute(path)) {
    if (path.includes('\0') || path.split(/[\\/]+/).includes('..') || path.startsWith('/')) throw new BackendError('EVIDENCE_PATH_INVALID', 'evidence path is not relative');
    return path.replaceAll('\\', '/');
  }
  const result = relative(resolve(root), resolve(path)).replaceAll('\\', '/');
  if (!result || result === '..' || result.startsWith('../') || result.startsWith('/')) throw new BackendError('EVIDENCE_PATH_INVALID', 'evidence path escapes the staging directory');
  return result;
}

function errorFor(cause: unknown, fallback: string): BackendError {
  if (cause instanceof BackendError) return cause;
  if (cause instanceof Error && isRecord(cause) && typeof cause.code === 'string') return new BackendError(cause.code, cause.message, 'ambiguousState');
  return new BackendError(fallback, cause instanceof Error ? cause.message : String(cause), 'ambiguousState');
}

function blockedResult(code: string, message: string, category: DomainError['category'] = 'capability'): QualificationResult {
  return QualificationResultSchema.parse({
    status: 'blocked',
    candidate: null,
    checks: [],
    evidencePaths: [],
    errors: [{ code, category, message, retryable: category === 'transient', evidencePaths: [] }],
  });
}

export class PhotoshopBackend {
  constructor(private readonly adapter: BackendAdapter) {}

  async capabilities(signal: AbortSignal): Promise<CapabilityReport> {
    return this.adapter.lock.runExclusive('capabilities', async () => {
      checkpoint(signal);
      return CapabilityReportSchema.parse(await this.adapter.capabilities(signal));
    }, signal);
  }

  async inspect(templatePath: string, signal: AbortSignal): Promise<InspectionReport> {
    return this.adapter.lock.runExclusive(`inspect-${templatePath}`, async () => {
      checkpoint(signal);
      return InspectionReportSchema.parse(await this.adapter.inspect(templatePath, signal));
    }, signal);
  }

  async qualify(request: QualificationRequest, signal: AbortSignal): Promise<QualificationResult> {
    const qualification = this.adapter.qualification;
    if (!qualification) return blockedResult('QUALIFICATION_ADAPTER_MISSING', 'qualification adapter is not configured');
    try {
      const options: QualificationOptions = {
        adapter: qualification.adapter,
        approvedCapability: qualification.approvedCapability,
        approvedTemplateRoots: qualification.approvedTemplateRoots,
        approvedEvidenceRoots: qualification.approvedEvidenceRoots,
      };
      return QualificationResultSchema.parse(await qualifyTemplate(request, signal, options));
    } catch (cause) {
      return blockedResult('QUALIFICATION_FAILED', cause instanceof Error ? cause.message : String(cause), 'ambiguousState');
    }
  }

  async render(request: RenderRequest, signal: AbortSignal): Promise<RenderEvidence> {
    const parsed = RenderRequestSchema.parse(request);
    return this.adapter.lock.runExclusive(parsed.jobId, async () => this.renderLocked(parsed, signal), signal);
  }

  async recover(jobId: string, signal: AbortSignal): Promise<{ safe: boolean; evidencePaths: string[] }> {
    return this.adapter.lock.runExclusive(`recover-${jobId}`, async () => {
      checkpoint(signal);
      if (!this.adapter.recover) return { safe: false, evidencePaths: [] };
      const result = await this.adapter.recover(jobId, signal);
      if (!result || typeof result.safe !== 'boolean' || !Array.isArray(result.evidencePaths)) throw new BackendError('RECOVERY_RESULT_INVALID', 'recovery returned an invalid result');
      return { safe: result.safe, evidencePaths: result.evidencePaths.map((path) => relativeEvidence(process.cwd(), path)) };
    }, signal);
  }

  private async renderLocked(request: RenderRequest, signal: AbortSignal): Promise<RenderEvidence> {
    checkpoint(signal);
    const capability = CapabilityReportSchema.parse(await this.adapter.capabilities(signal));
    if (request.profile.backendId !== capability.backendId || request.profile.toolSchemaSha256 !== capability.toolSchemaSha256) {
      throw new BackendError('PROFILE_TOOL_BINDING_MISMATCH', 'profile is not bound to the current qualified backend/tool schema', 'capability');
    }
    if (!capability.supportedFitModes.includes(request.profile.fitMode)) throw new BackendError('FIT_MODE_UNSUPPORTED', `fit mode ${request.profile.fitMode} is not qualified`, 'capability');
    if (!/^[a-f0-9]{64}$/.test(request.profile.profileSha256) || !request.profile.qualificationId) throw new BackendError('PROFILE_NOT_SEALED', 'render requires an A-sealed TemplateProfile');

    let session: RenderSession | undefined;
    let cleanupComplete = false;
    try {
      session = await this.adapter.createWorkingCopy(request, signal);
      if (!session || !session.workingTemplatePath || !session.openRoot || !session.verifyGraph || !session.renderResource || !session.verifyPropagation || !session.exporter || !session.verifyOriginals || !session.discard) throw new BackendError('TRANSACTION_ADAPTER_INVALID', 'working-copy transaction is incomplete', 'capability');
      const bundleRoot = session.bundleRoot ?? request.stagingDirectory;
      if (!isAbsolute(bundleRoot) || resolve(bundleRoot) !== resolve(request.stagingDirectory)) throw new BackendError('BUNDLE_ROOT_INVALID', 'transaction bundle root must equal request stagingDirectory');
      await mkdir(bundleRoot, { recursive: true });

      // The session owns the isolated copy; these calls deliberately precede every mutation.
      checkpoint(signal); await session.openRoot();
      checkpoint(signal); await session.verifyGraph(request);

      const placements: RenderPlacement[] = [];
      const seen = new Set<string>();
      for (const resource of session.resources) {
        const key = resource.resourceId || digest(resource.target);
        if (seen.has(key)) continue;
        seen.add(key);
        checkpoint(signal);
        const placement = await session.renderResource(resource, request.asset, request.profile.fitMode, signal);
        if (placement.fitMode !== request.profile.fitMode || !placement.clipped || !placement.adjacentToReference) throw new BackendError('GEOMETRY_CHECK_FAILED', `resource ${key} failed final geometry/clipping checks`);
        placements.push({ ...placement, target: placement.target ?? resource.target });
      }
      if (placements.length === 0) throw new BackendError('TARGETS_MISSING', 'qualified profile has no distinct target resources');

      checkpoint(signal); await session.verifyPropagation([...session.resources], signal);
      if (request.profile.output.format === 'jpeg' && !session.jpegBackground) throw new BackendError('EXPORT_POLICY_INVALID', 'qualified JPEG background policy is missing', 'capability');
      const exported: ExportResult = await exportVariants({
        bundleRoot,
        approvedBundleRoot: request.stagingDirectory,
        output: request.profile.output,
        adapter: session.exporter,
        alphaPolicy: request.profile.output.format === 'png' ? 'preserve' : 'opaque',
        ...(session.jpegBackground ? { jpegBackground: session.jpegBackground } : {}),
        renderingIntent: session.renderingIntent ?? 'relative-colorimetric',
        ...(request.profile.output.format === 'jpeg' ? { qualityEvidence: session.qualityEvidence ?? { unit: '1-100' as const } } : {}),
        signal,
      });

      checkpoint(signal);
      if (!await session.verifyOriginals()) throw new BackendError('SOURCE_MUTATED', 'master or linked dependency hash changed', 'ambiguousState');

      const checks = [
        ...placements.map((placement, index) => ({ id: `geometry-${index + 1}`, passed: true, evidencePath: `checks/geometry-${index + 1}.json` })),
        { id: 'propagation', passed: true, evidencePath: 'checks/propagation.json' },
        { id: 'source-integrity', passed: true, evidencePath: 'checks/source-integrity.json' },
      ];
      for (const check of checks) {
        await mkdir(resolve(bundleRoot, check.evidencePath, '..'), { recursive: true });
        await writeFile(resolve(bundleRoot, check.evidencePath), JSON.stringify({ id: check.id, passed: check.passed }));
      }
      const documentTracePath = relativeEvidence(bundleRoot, session.documentTracePath ?? resolve(bundleRoot, 'document-trace.json'));
      const toolTracePath = relativeEvidence(bundleRoot, session.toolTracePath ?? resolve(bundleRoot, 'tool-trace.json'));
      for (const path of [documentTracePath, toolTracePath]) {
        await mkdir(resolve(bundleRoot, path, '..'), { recursive: true });
        try { await access(resolve(bundleRoot, path)); } catch { await writeFile(resolve(bundleRoot, path), JSON.stringify({ jobId: request.jobId, assetId: request.asset.assetId })); }
      }
      const evidence = RenderEvidenceSchema.parse({
        schemaVersion: 1,
        jobId: request.jobId,
        assetId: request.asset.assetId,
        attempt: request.attempt,
        profileSha256: request.profile.profileSha256,
        sourceSha256: request.asset.source.sha256,
        toolSchemaSha256: request.profile.toolSchemaSha256,
        geometry: placements.map((placement) => ({ target: placement.target!, reference: placement.reference, placed: placement.placed, fitMode: placement.fitMode, clipped: placement.clipped, adjacentToReference: placement.adjacentToReference })),
        visibility: exported.visibility.map((item) => ({ variantId: item.variantId, visibleVariantIds: item.visibleVariantIds })),
        artifacts: exported.artifacts,
        checks,
        documentTracePath,
        toolTracePath,
      });
      await session.discard();
      cleanupComplete = true;
      return evidence;
    } catch (cause) {
      if (session && !cleanupComplete) {
        try { await session.discard(); cleanupComplete = true; } catch { await this.adapter.lock.markUnknownMutation?.().catch(() => undefined); }
      }
      throw errorFor(cause, 'RENDER_BLOCKED');
    }
  }
}

export function createPhotoshopBackend(options: BackendOptions): PhotoshopBackend { return new PhotoshopBackend(options); }
