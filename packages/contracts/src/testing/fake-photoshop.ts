import sharp from 'sharp';
import {
  CapabilityReportSchema,
  type CapabilityReport,
  type InspectionReport,
  type QualificationRequest,
  type QualificationResult,
  type RenderEvidence,
  RenderEvidenceSchema,
  type RenderRequest,
  RenderRequestSchema,
  type VariantArtifact,
} from '../index.js';
import { sha256Bytes } from '../canonicalize.js';
import type { PhotoshopBackend } from '../services.js';
import {
  FakeFailureError,
  type FakeArtifactBytes,
  type FakeConfig,
  fixtureRoot,
  fixedClock,
  loadFixture,
  nextId,
  resolveFailureSchedule,
  testOnlyPath,
} from './fixture-loader.js';

export type PhotoshopOperation = {
  readonly id: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly name: 'capabilities' | 'inspect' | 'qualify' | 'render' | 'recover';
  readonly jobId?: string;
  readonly assetId?: string;
  readonly attempt?: number;
};

export type FakeRenderBundle = {
  readonly testOnly: true;
  readonly evidence: RenderEvidence;
  readonly artifacts: readonly (VariantArtifact & FakeArtifactBytes)[];
};

export type FakePhotoshopOptions = FakeConfig & {
  readonly fixtureRoot?: string;
};

const VARIANT_COLORS: Record<string, { r: number; g: number; b: number }> = {
  '1': { r: 220, g: 70, b: 70 },
  '2': { r: 70, g: 150, b: 220 },
  '3': { r: 80, g: 190, b: 110 },
};

export class FakePhotoshop implements PhotoshopBackend {
  readonly testOnly = true as const;
  private readonly clock;
  private readonly schedule;
  private readonly fixtureRootPath: string;
  private readonly operationCounter = { value: 0 };
  private readonly operationsLog: PhotoshopOperation[] = [];
  private readonly artifactStore = new Map<string, Uint8Array>();
  private lastBundleValue: FakeRenderBundle | null = null;

  constructor(options: FakePhotoshopOptions = {}) {
    this.clock = options.clock ?? fixedClock();
    this.schedule = resolveFailureSchedule(options);
    this.fixtureRootPath = options.fixtureRoot ?? fixtureRoot();
  }

  get operations(): readonly PhotoshopOperation[] {
    return this.operationsLog.map((operation) => ({ ...operation }));
  }

  get lastBundle(): FakeRenderBundle | null {
    return this.lastBundleValue;
  }

  readArtifact(path: string): Uint8Array | undefined {
    const bytes = this.artifactStore.get(path);
    return bytes === undefined ? undefined : new Uint8Array(bytes);
  }

  async capabilities(signal: AbortSignal): Promise<CapabilityReport> {
    this.throwIfAborted(signal);
    this.record('capabilities');
    this.failIfScheduled('storage:capabilities');
    const fixture = loadFixture<CapabilityReport>('capabilities.fake.json', this.fixtureRootPath);
    return CapabilityReportSchema.parse({ ...fixture, evidencePaths: fixture.evidencePaths.map(testOnlyPath) });
  }

  async inspect(templatePath: string, signal: AbortSignal): Promise<InspectionReport> {
    this.throwIfAborted(signal);
    this.record('inspect');
    this.failIfScheduled('storage:inspect');
    const fixture = loadFixture<InspectionReport>('inspection.live.json', this.fixtureRootPath);
    return {
      ...fixture,
      template: { ...fixture.template, relativePath: testOnlyPath(templatePath.split(/[\\/]/).pop() ?? fixture.template.relativePath) },
      evidencePaths: fixture.evidencePaths.map(testOnlyPath),
      capabilities: fixture.capabilities === null ? null : { ...fixture.capabilities, evidencePaths: fixture.capabilities.evidencePaths.map(testOnlyPath) },
    };
  }

  async qualify(request: QualificationRequest, signal: AbortSignal): Promise<QualificationResult> {
    this.throwIfAborted(signal);
    this.record('qualify');
    this.failIfScheduled('storage:qualify');
    const fixture = loadFixture<QualificationResult>('qualification-result.json', this.fixtureRootPath);
    return {
      ...fixture,
      evidencePaths: fixture.evidencePaths.map(testOnlyPath),
      checks: fixture.checks.map((check) => ({ ...check, evidencePath: testOnlyPath(check.evidencePath) })),
    };
  }

  async render(request: RenderRequest, signal: AbortSignal): Promise<RenderEvidence> {
    RenderRequestSchema.parse(request);
    this.throwIfAborted(signal);
    this.record('render', request);
    this.failIfScheduled('mutationTimeout', 'cancelDuringChildSave', 'oneExportMissing', 'sourceChanged', 'storage:render');

    const artifacts: Array<VariantArtifact & FakeArtifactBytes> = [];
    const { width, height, format, quality } = request.profile.output;
    for (const variant of request.profile.variants) {
      const path = testOnlyPath(`render/${request.jobId}/${request.asset.assetId}/attempt-${request.attempt}/variant-${variant.id}.${format}`);
      const color = VARIANT_COLORS[variant.id] ?? { r: 128, g: 128, b: 128 };
      const image = sharp({ create: { width, height, channels: 3, background: color } });
      const bytes = format === 'png' ? await image.png().toBuffer() : await image.jpeg({ quality }).toBuffer();
      const artifact: VariantArtifact & FakeArtifactBytes = {
        testOnly: true,
        variantId: variant.id,
        path,
        sha256: sha256Bytes(bytes),
        data: new Uint8Array(bytes),
        colorSpace: 'sRGB',
        width,
        height,
        format,
        bytes: bytes.byteLength,
      } as VariantArtifact & FakeArtifactBytes;
      this.artifactStore.set(path, new Uint8Array(bytes));
      artifacts.push(artifact);
    }

    const geometry = request.profile.targets.map((target) => ({
      target: target.target,
      reference: { left: 0, top: 0, right: width, bottom: height },
      placed: { left: 0, top: 0, right: width, bottom: height },
      fitMode: request.profile.fitMode,
      clipped: request.profile.fitMode === 'cover',
      adjacentToReference: true,
    }));
    const basePath = testOnlyPath(`render/${request.jobId}/${request.asset.assetId}/attempt-${request.attempt}`);
    const evidence: RenderEvidence = RenderEvidenceSchema.parse({
      schemaVersion: 1,
      jobId: request.jobId,
      assetId: request.asset.assetId,
      attempt: request.attempt,
      profileSha256: request.profile.profileSha256,
      sourceSha256: request.asset.source.sha256,
      toolSchemaSha256: request.profile.toolSchemaSha256,
      geometry,
      visibility: request.profile.variants.map((variant) => ({ variantId: variant.id, visibleVariantIds: [variant.id] })),
      artifacts: artifacts.map(({ testOnly: _testOnly, data: _data, ...artifact }) => artifact),
      checks: [
        'BINDING.CURRENT_ATTEMPT', 'MANIFEST.COMPLETE', 'ARTIFACTS.EXACTLY_THREE', 'IMAGE.DECODE_FORMAT',
        'IMAGE.DIMENSIONS_COLOR', 'GEOMETRY.REQUESTED_FIT', 'CLIPPING.ALPHA_ADJACENCY', 'VARIANTS.VISIBILITY',
        'SMART_OBJECT.LINEAGE_PROPAGATION', 'SAFETY.LINKED_ISOLATION', 'SAFETY.ORIGINALS_UNCHANGED',
        'SAFETY.DOCUMENT_OWNERSHIP', 'IMAGE.QUALITY', 'EVIDENCE.TRACE_COMPLETE',
      ].map((id) => ({ id, passed: true, evidencePath: `${basePath}/checks/${id}.json` })),
      documentTracePath: `${basePath}/document-trace.json`,
      toolTracePath: `${basePath}/tool-trace.json`,
    });
    this.lastBundleValue = { testOnly: true, evidence, artifacts };
    return evidence;
  }

  async recover(jobId: string, signal: AbortSignal): Promise<{ safe: boolean; evidencePaths: string[] }> {
    this.throwIfAborted(signal);
    this.record('recover', { jobId });
    this.failIfScheduled('crashBeforePublish');
    return { safe: true, evidencePaths: [testOnlyPath(`recovery/${jobId}.json`)] };
  }

  private record(name: PhotoshopOperation['name'], request?: { jobId?: string; assetId?: string; attempt?: number }): void {
    if (this.schedule.consume(`storage:${name}`)) throw new FakeFailureError(`storage:${name}`);
    this.operationsLog.push({
      id: nextId('photoshop-op', this.operationCounter),
      sequence: this.operationsLog.length + 1,
      timestamp: this.clock.now().toISOString(),
      name,
      ...(request?.jobId === undefined ? {} : { jobId: request.jobId }),
      ...(request?.assetId === undefined ? {} : { assetId: request.assetId }),
      ...(request?.attempt === undefined ? {} : { attempt: request.attempt }),
    });
  }

  private failIfScheduled(...names: string[]): void {
    for (const name of names) if (this.schedule.consume(name)) throw new FakeFailureError(name);
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new DOMException('The operation was aborted', 'AbortError');
  }
}

export function createFakePhotoshop(options: FakePhotoshopOptions = {}): FakePhotoshop {
  return new FakePhotoshop(options);
}
