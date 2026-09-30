import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sha256Bytes, sha256Json, type OutputSpec } from '@ne-psd/contracts';
import { inspectImageQuality, type ColorEvidence, type ColorExportProof, type ImageArtifact, type ImageQualityInput, type ImageQualityPolicy } from '../../packages/intelligence/dist/review/image-quality.js';

const fixture = (name: string) => readFile(fileURLToPath(new URL(`./fixtures/artifacts/${name}`, import.meta.url)));
const digest = 'a'.repeat(64);
const output: OutputSpec = { format: 'png', quality: 95, colorSpace: 'sRGB', width: 16, height: 12 };
function policy(overrides: Partial<ImageQualityPolicy> = {}): ImageQualityPolicy {
  const base = { qualified: true as const, profileSha256: digest, templateSha256: 'b'.repeat(64),
    backendQualificationSha256: 'c'.repeat(64), transformId: 'photoshop-export-srgb-v1', output,
    maxInputBytes: 100_000, maxPixels: 500, maxDecodedBytes: 2_000,
    backgroundRgb: [255, 255, 255] as const, foregroundDistance: 30, alphaThreshold: 128,
    metrics: { minForegroundFraction: 0.1, alphaFraction: { min: 1, max: 1 }, roi: { rect: { x: 4, y: 3, width: 8, height: 6 }, minForegroundFraction: 0.9 } } };
  const value = { ...base, ...overrides };
  return { ...value, policySha256: sha256Json(value) };
}
async function makeInput(names: readonly string[] = ['flat.png', 'flat.png', 'flat.png'], pol = policy()): Promise<ImageQualityInput> {
  const artifacts = await Promise.all(names.map(async (name, index) => {
    const bytes = await fixture(name);
    return { variantId: (index + 1) as 1 | 2 | 3, relativePath: `artifact-${index + 1}.${name.split('.').at(-1)}`, bytes, sha256: sha256Bytes(bytes) } satisfies ImageArtifact;
  }));
  const proofs: ColorExportProof[] = artifacts.map((artifact) => ({ variantId: artifact.variantId, artifactSha256: artifact.sha256,
    profileSha256: pol.profileSha256, templateSha256: pol.templateSha256, backendQualificationSha256: pol.backendQualificationSha256,
    transformId: pol.transformId, outputColorSpace: 'sRGB' }));
  const traceBytes = Buffer.from(JSON.stringify({ colorExports: proofs }));
  const colorEvidence: ColorEvidence = { traceBytes, traceSha256: sha256Bytes(traceBytes), proofs };
  return { artifacts, output: pol.output, policy: pol, colorEvidence };
}

describe('deterministic image QA', () => {
  it('keeps generated fixture byte counts and digests reproducible', async () => {
    const manifest = JSON.parse((await fixture('digests.json')).toString()) as Record<string, { bytes: number; sha256: string }>;
    for (const [name, expected] of Object.entries(manifest)) {
      const bytes = await fixture(name);
      expect({ bytes: bytes.byteLength, sha256: sha256Bytes(bytes) }).toEqual(expected);
    }
  });
  it('accepts correct JPEG and records decoder, thresholds, and actual digests', async () => {
    const p = policy({ output: { ...output, format: 'jpeg' } });
    const input = await makeInput(['correct.jpg', 'correct.jpg', 'correct.jpg'], p);
    const result = await inspectImageQuality(input);
    expect(result.passed).toBe(true);
    expect(result.decoder.name).toBe('sharp');
    expect(result.decoder.version).toBe('0.35.4');
    expect(result.inputDigests[0]?.sha256).toBe(input.artifacts[0]?.sha256);
    expect(result.thresholds).toEqual(p.metrics);
  });
  it('rejects a PNG disguised as JPEG', async () => {
    const p = policy({ output: { ...output, format: 'jpeg' } });
    expect((await inspectImageQuality(await makeInput(['disguised.jpg', 'correct.jpg', 'correct.jpg'], p))).reasons).toContain('VARIANT.1.FORMAT');
  });
  it('rejects zero bytes, truncated JPEG, and bomb dimensions', async () => {
    const empty = await makeInput(['empty.png', 'flat.png', 'flat.png']);
    expect((await inspectImageQuality(empty)).reasons).toContain('VARIANT.1.BYTES_OR_DIGEST');
    const jpeg = policy({ output: { ...output, format: 'jpeg' } });
    const truncated = await makeInput(['truncated.jpg', 'correct.jpg', 'correct.jpg'], jpeg);
    expect((await inspectImageQuality(truncated)).reasons).toContain('VARIANT.1.DECODE_FAILED');
    const bomb = await makeInput(['bomb.png', 'flat.png', 'flat.png']);
    expect((await inspectImageQuality(bomb)).reasons).toContain('VARIANT.1.DECODE_FAILED');
  });
  it('rejects unexpected width and an artifact digest mismatch', async () => {
    expect((await inspectImageQuality(await makeInput(['wrong-width.png', 'flat.png', 'flat.png']))).reasons).toContain('VARIANT.1.DIMENSIONS');
    const input = await makeInput();
    const artifacts = input.artifacts.map((artifact, index) => index === 0 ? { ...artifact, sha256: digest } : artifact);
    expect((await inspectImageQuality({ ...input, artifacts })).reasons).toContain('VARIANT.1.BYTES_OR_DIGEST');
  });
  it('fails unqualified policy and missing, wrong, or unbound color evidence', async () => {
    const input = await makeInput();
    expect((await inspectImageQuality({ ...input, policy: null })).reasons).toContain('POLICY.UNQUALIFIED_OR_INVALID');
    expect((await inspectImageQuality({ ...input, colorEvidence: null })).reasons).toContain('COLOR.EVIDENCE_MISSING_OR_DIGEST');
    expect((await inspectImageQuality({ ...input, colorEvidence: { ...input.colorEvidence!, traceSha256: digest } })).reasons).toContain('COLOR.EVIDENCE_MISSING_OR_DIGEST');
    expect((await inspectImageQuality({ ...input, colorEvidence: { ...input.colorEvidence!, proofs: input.colorEvidence!.proofs.map((p, i) => i ? p : { ...p, transformId: 'unqualified' }) } })).reasons).toContain('COLOR.TRACE_PROOF_MISMATCH');
    const proofs = input.colorEvidence!.proofs.map((p, i) => i ? p : { ...p, outputColorSpace: 'sRGB' as const, profileSha256: digest.replaceAll('a', 'e') });
    const traceBytes = Buffer.from(JSON.stringify({ colorExports: proofs }));
    expect((await inspectImageQuality({ ...input, colorEvidence: { proofs, traceBytes, traceSha256: sha256Bytes(traceBytes) } })).reasons).toContain('VARIANT.1.COLOR_BINDING');
  });
  it('rejects transparent and blank exports against qualified foreground and alpha thresholds', async () => {
    expect((await inspectImageQuality(await makeInput(['transparent.png', 'flat.png', 'flat.png']))).reasons).toEqual(expect.arrayContaining(['VARIANT.1.FOREGROUND', 'VARIANT.1.ALPHA', 'VARIANT.1.ROI']));
    expect((await inspectImageQuality(await makeInput(['blank.png', 'flat.png', 'flat.png']))).reasons).toEqual(expect.arrayContaining(['VARIANT.1.FOREGROUND', 'VARIANT.1.ROI']));
  });
  it('accepts flat foreground, contain margins, and intentional identical or similar outputs', async () => {
    expect((await inspectImageQuality(await makeInput())).passed).toBe(true);
    expect((await inspectImageQuality(await makeInput(['flat.png', 'flat.png', 'variant-2.png']))).passed).toBe(true);
  });
  it('applies qualified ROI, reference preservation, and sentinel distinctness', async () => {
    const reference = await fixture('reference.png');
    const p = policy({ metrics: { minForegroundFraction: 0.1,
      roi: { rect: { x: 4, y: 3, width: 8, height: 6 }, minForegroundFraction: 0.9 },
      preservation: { rect: { x: 0, y: 0, width: 2, height: 2 }, maxMeanAbsoluteDifference: 0.02 },
      sentinel: { rect: { x: 4, y: 3, width: 8, height: 6 }, minPairwiseMeanAbsoluteDifference: 0.1 } } });
    const identical = await makeInput(['flat.png', 'flat.png', 'flat.png'], p);
    expect((await inspectImageQuality({ ...identical, reference: { bytes: reference, sha256: sha256Bytes(reference) } })).reasons).toContain('VARIANT.1.SENTINEL');
    const distinct = await makeInput(['flat.png', 'variant-2.png', 'variant-3.png'], p);
    const result = await inspectImageQuality({ ...distinct, reference: { bytes: reference, sha256: sha256Bytes(reference) } });
    expect(result.passed).toBe(true);
    expect(result.metrics[0]?.values.preservationMeanAbsoluteDifference).toBe(0);
    expect((await inspectImageQuality(distinct)).reasons).toContain('REFERENCE.MISSING_OR_DIGEST');
  });
  it('rejects foreground outside the qualified ROI and a changed template region', async () => {
    expect((await inspectImageQuality(await makeInput(['misplaced.png', 'flat.png', 'flat.png']))).reasons).toContain('VARIANT.1.ROI');
    const p = policy({ metrics: { minForegroundFraction: 0.1,
      preservation: { rect: { x: 0, y: 0, width: 2, height: 2 }, maxMeanAbsoluteDifference: 0.02 } } });
    const bytes = await fixture('reference.png');
    const input = await makeInput(['background-changed.png', 'flat.png', 'flat.png'], p);
    expect((await inspectImageQuality({ ...input, reference: { bytes, sha256: sha256Bytes(bytes) } })).reasons).toContain('VARIANT.1.PRESERVATION');
  });
});
