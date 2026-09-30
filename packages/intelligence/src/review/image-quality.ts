import { sha256Bytes, sha256Json, type OutputSpec } from '@ne-psd/contracts';
import sharp from 'sharp';

export type Rect = Readonly<{ x: number; y: number; width: number; height: number }>;
export type ImageArtifact = Readonly<{ variantId: 1 | 2 | 3; relativePath: string; bytes: Uint8Array; sha256: string }>;
export type ColorExportProof = Readonly<{
  variantId: 1 | 2 | 3;
  artifactSha256: string;
  profileSha256: string;
  templateSha256: string;
  backendQualificationSha256: string;
  transformId: string;
  outputColorSpace: 'sRGB';
}>;
export type ColorEvidence = Readonly<{ traceBytes: Uint8Array; traceSha256: string; proofs: readonly ColorExportProof[] }>;
export type MetricLimits = Readonly<{
  minForegroundFraction?: number;
  alphaFraction?: Readonly<{ min: number; max: number }>;
  roi?: Readonly<{ rect: Rect; minForegroundFraction: number }>;
  preservation?: Readonly<{ rect: Rect; maxMeanAbsoluteDifference: number }>;
  sentinel?: Readonly<{ rect: Rect; minPairwiseMeanAbsoluteDifference: number }>;
}>;
export type ImageQualityPolicy = Readonly<{
  qualified: true;
  policySha256: string;
  profileSha256: string;
  templateSha256: string;
  backendQualificationSha256: string;
  transformId: string;
  output: OutputSpec;
  maxInputBytes: number;
  maxPixels: number;
  maxDecodedBytes: number;
  backgroundRgb: readonly [number, number, number];
  foregroundDistance: number;
  alphaThreshold: number;
  metrics: MetricLimits;
}>;
export type ImageQualityInput = Readonly<{
  artifacts: readonly ImageArtifact[];
  output: OutputSpec;
  policy: ImageQualityPolicy | null;
  colorEvidence: ColorEvidence | null;
  reference?: Readonly<{ bytes: Uint8Array; sha256: string }>;
}>;
export type ImageMetrics = Readonly<{
  alphaFraction: number;
  foregroundFraction: number;
  roiForegroundFraction?: number;
  preservationMeanAbsoluteDifference?: number;
  sentinelPairwiseMeanAbsoluteDifference?: number;
}>;
export type ImageQualityReport = Readonly<{
  passed: boolean;
  decoder: Readonly<{ name: 'sharp'; version: string; vipsVersion: string }>;
  policySha256: string | null;
  inputDigests: readonly Readonly<{ variantId: 1 | 2 | 3; sha256: string; bytes: number }>[];
  referenceSha256: string | null;
  colorTraceSha256: string | null;
  thresholds: MetricLimits | null;
  metrics: readonly Readonly<{ variantId: 1 | 2 | 3; values: ImageMetrics }>[];
  reasons: readonly string[];
}>;

const decoder = Object.freeze({ name: 'sharp' as const, version: sharp.versions.sharp, vipsVersion: sharp.versions.vips });
const variantIds = [1, 2, 3] as const;

function validFraction(n: number): boolean { return Number.isFinite(n) && n >= 0 && n <= 1; }
function validRect(rect: Rect, width: number, height: number): boolean {
  return [rect.x, rect.y, rect.width, rect.height].every(Number.isInteger) && rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0 && rect.x + rect.width <= width && rect.y + rect.height <= height;
}
function validPolicy(policy: ImageQualityPolicy, output: OutputSpec): boolean {
  if (policy.qualified !== true || policy.policySha256 !== sha256Json(policy, { excludeKeys: ['policySha256'] }) ||
    policy.output.format !== output.format || policy.output.quality !== output.quality || policy.output.colorSpace !== output.colorSpace ||
    policy.output.width !== output.width || policy.output.height !== output.height ||
    ![policy.maxInputBytes, policy.maxPixels, policy.maxDecodedBytes].every((n) => Number.isSafeInteger(n) && n > 0) ||
    !policy.backgroundRgb.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ||
    !Number.isFinite(policy.foregroundDistance) || policy.foregroundDistance < 0 || policy.foregroundDistance > 255 ||
    !Number.isInteger(policy.alphaThreshold) || policy.alphaThreshold < 0 || policy.alphaThreshold > 255) return false;
  const m = policy.metrics;
  if (!m || [m.minForegroundFraction, m.alphaFraction, m.roi, m.preservation, m.sentinel].every((value) => value === undefined)) return false;
  if (m.minForegroundFraction !== undefined && !validFraction(m.minForegroundFraction)) return false;
  if (m.alphaFraction && (!validFraction(m.alphaFraction.min) || !validFraction(m.alphaFraction.max) || m.alphaFraction.min > m.alphaFraction.max)) return false;
  if (m.roi && (!validRect(m.roi.rect, output.width, output.height) || !validFraction(m.roi.minForegroundFraction))) return false;
  if (m.preservation && (!validRect(m.preservation.rect, output.width, output.height) || !validFraction(m.preservation.maxMeanAbsoluteDifference))) return false;
  if (m.sentinel && (!validRect(m.sentinel.rect, output.width, output.height) || !validFraction(m.sentinel.minPairwiseMeanAbsoluteDifference))) return false;
  return /^[a-f0-9]{64}$/.test(policy.profileSha256) && /^[a-f0-9]{64}$/.test(policy.templateSha256) &&
    /^[a-f0-9]{64}$/.test(policy.backendQualificationSha256) && policy.transformId.length > 0;
}
function meanDifference(left: Uint8Array, right: Uint8Array, width: number, rect: Rect): number {
  let total = 0;
  for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) {
    const i = (y * width + x) * 4;
    for (let c = 0; c < 4; c++) total += Math.abs(left[i + c]! - right[i + c]!);
  }
  return total / (rect.width * rect.height * 4 * 255);
}
function fractions(raster: Uint8Array, width: number, rect: Rect, policy: ImageQualityPolicy): { alpha: number; foreground: number } {
  let alpha = 0;
  let foreground = 0;
  for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) {
    const i = (y * width + x) * 4;
    if (raster[i + 3]! >= policy.alphaThreshold) alpha++;
    const distance = Math.max(...policy.backgroundRgb.map((channel, c) => Math.abs(raster[i + c]! - channel)));
    if (raster[i + 3]! >= policy.alphaThreshold && distance >= policy.foregroundDistance) foreground++;
  }
  const area = rect.width * rect.height;
  return { alpha: alpha / area, foreground: foreground / area };
}

export async function inspectImageQuality(input: ImageQualityInput): Promise<ImageQualityReport> {
  const reasons: string[] = [];
  const metrics: { variantId: 1 | 2 | 3; values: ImageMetrics }[] = [];
  const policy = input.policy;
  const digests = input.artifacts.map((a) => ({ variantId: a.variantId, sha256: sha256Bytes(a.bytes), bytes: a.bytes.byteLength }));
  const report = (): ImageQualityReport => ({ passed: reasons.length === 0, decoder, policySha256: policy?.policySha256 ?? null,
    inputDigests: digests, referenceSha256: input.reference ? sha256Bytes(input.reference.bytes) : null,
    colorTraceSha256: input.colorEvidence ? sha256Bytes(input.colorEvidence.traceBytes) : null,
    thresholds: policy?.metrics ?? null, metrics, reasons });
  if (!policy || !validPolicy(policy, input.output)) { reasons.push('POLICY.UNQUALIFIED_OR_INVALID'); return report(); }
  const pixelLimit = Math.min(policy.maxPixels, Math.floor(policy.maxDecodedBytes / 4));
  if (pixelLimit < 1 || !Number.isSafeInteger(input.output.width * input.output.height) || input.output.width * input.output.height > pixelLimit) {
    reasons.push('BOUNDS.DECODE_LIMIT'); return report();
  }
  if (input.artifacts.length !== 3 || variantIds.some((id) => input.artifacts.filter((a) => a.variantId === id).length !== 1)) {
    reasons.push('ARTIFACTS.EXACTLY_THREE'); return report();
  }
  // Take private byte copies before the first asynchronous decode. Caller-owned arrays may be reused.
  const snapshots = input.artifacts.map((artifact) => artifact.bytes.byteLength <= policy.maxInputBytes ? Buffer.from(artifact.bytes) : null);
  const referenceSnapshot = input.reference && input.reference.bytes.byteLength <= policy.maxInputBytes ? Buffer.from(input.reference.bytes) : null;
  const evidence = input.colorEvidence;
  if (!evidence || evidence.traceBytes.byteLength > policy.maxInputBytes || sha256Bytes(evidence.traceBytes) !== evidence.traceSha256 ||
    evidence.proofs.length !== 3 || variantIds.some((id) => evidence.proofs.filter((p) => p.variantId === id).length !== 1)) {
    reasons.push('COLOR.EVIDENCE_MISSING_OR_DIGEST'); return report();
  }
  // The sealed trace contains the exact proof records. A detached caller flag is never sufficient.
  let trace: unknown;
  try { trace = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(evidence.traceBytes)); }
  catch { reasons.push('COLOR.TRACE_INVALID'); return report(); }
  if (sha256Json(trace) !== sha256Json({ colorExports: evidence.proofs })) {
    reasons.push('COLOR.TRACE_PROOF_MISMATCH'); return report();
  }
  const rasters = new Map<1 | 2 | 3, Uint8Array>();
  for (const [index, artifact] of input.artifacts.entries()) {
    const id = artifact.variantId;
    const bytes = snapshots[index];
    if (!bytes || bytes.byteLength === 0 || sha256Bytes(bytes) !== artifact.sha256) {
      reasons.push(`VARIANT.${id}.BYTES_OR_DIGEST`); continue;
    }
    const proof = evidence.proofs.find((p) => p.variantId === id)!;
    if (proof.artifactSha256 !== artifact.sha256 || proof.profileSha256 !== policy.profileSha256 ||
      proof.templateSha256 !== policy.templateSha256 || proof.backendQualificationSha256 !== policy.backendQualificationSha256 ||
      proof.transformId !== policy.transformId || proof.outputColorSpace !== 'sRGB') {
      reasons.push(`VARIANT.${id}.COLOR_BINDING`); continue;
    }
    try {
      const probe = sharp(bytes, { failOn: 'error', limitInputPixels: pixelLimit });
      const meta = await probe.metadata();
      if (meta.format !== input.output.format) { reasons.push(`VARIANT.${id}.FORMAT`); continue; }
      if (meta.pages && meta.pages !== 1) { reasons.push(`VARIANT.${id}.PAGES`); continue; }
      if (meta.width !== input.output.width || meta.height !== input.output.height) { reasons.push(`VARIANT.${id}.DIMENSIONS`); continue; }
      if (meta.width * meta.height > pixelLimit) { reasons.push(`VARIANT.${id}.BOUNDS`); continue; }
      const { data, info } = await sharp(bytes, { failOn: 'error', limitInputPixels: pixelLimit }).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      if (info.width !== input.output.width || info.height !== input.output.height || info.channels !== 4 || data.byteLength > policy.maxDecodedBytes) {
        reasons.push(`VARIANT.${id}.DECODE_SHAPE`); continue;
      }
      rasters.set(id, data);
    } catch { reasons.push(`VARIANT.${id}.DECODE_FAILED`); }
  }
  let reference: Uint8Array | null = null;
  if (policy.metrics.preservation) {
    if (!input.reference || !referenceSnapshot || referenceSnapshot.byteLength === 0 || sha256Bytes(referenceSnapshot) !== input.reference.sha256) {
      reasons.push('REFERENCE.MISSING_OR_DIGEST');
    } else try {
      const { data, info } = await sharp(referenceSnapshot, { failOn: 'error', limitInputPixels: pixelLimit }).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      if (info.width !== input.output.width || info.height !== input.output.height || info.channels !== 4 || data.byteLength > policy.maxDecodedBytes) reasons.push('REFERENCE.DECODE_SHAPE');
      else reference = data;
    } catch { reasons.push('REFERENCE.DECODE_FAILED'); }
  }
  const whole = { x: 0, y: 0, width: input.output.width, height: input.output.height };
  for (const id of variantIds) {
    const raster = rasters.get(id);
    if (!raster) continue;
    const all = fractions(raster, input.output.width, whole, policy);
    const values: { alphaFraction: number; foregroundFraction: number; roiForegroundFraction?: number; preservationMeanAbsoluteDifference?: number; sentinelPairwiseMeanAbsoluteDifference?: number } = {
      alphaFraction: all.alpha, foregroundFraction: all.foreground
    };
    const limits = policy.metrics;
    if (limits.minForegroundFraction !== undefined && all.foreground < limits.minForegroundFraction) reasons.push(`VARIANT.${id}.FOREGROUND`);
    if (limits.alphaFraction && (all.alpha < limits.alphaFraction.min || all.alpha > limits.alphaFraction.max)) reasons.push(`VARIANT.${id}.ALPHA`);
    if (limits.roi) {
      values.roiForegroundFraction = fractions(raster, input.output.width, limits.roi.rect, policy).foreground;
      if (values.roiForegroundFraction < limits.roi.minForegroundFraction) reasons.push(`VARIANT.${id}.ROI`);
    }
    if (limits.preservation && reference) {
      values.preservationMeanAbsoluteDifference = meanDifference(raster, reference, input.output.width, limits.preservation.rect);
      if (values.preservationMeanAbsoluteDifference > limits.preservation.maxMeanAbsoluteDifference) reasons.push(`VARIANT.${id}.PRESERVATION`);
    }
    if (limits.sentinel) {
      const others = variantIds.filter((other) => other !== id).map((other) => rasters.get(other)).filter((other): other is Uint8Array => !!other);
      if (others.length === 2) {
        values.sentinelPairwiseMeanAbsoluteDifference = Math.min(...others.map((other) => meanDifference(raster, other, input.output.width, limits.sentinel!.rect)));
        if (values.sentinelPairwiseMeanAbsoluteDifference < limits.sentinel.minPairwiseMeanAbsoluteDifference) reasons.push(`VARIANT.${id}.SENTINEL`);
      }
    }
    metrics.push({ variantId: id, values });
  }
  return report();
}
