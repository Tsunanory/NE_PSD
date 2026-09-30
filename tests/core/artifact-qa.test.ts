import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { JobSpec, RenderEvidence, RenderRequest, VariantArtifact } from '@ne-psd/contracts';
import { verifyArtifactQa, type ArtifactQaInput } from '../../packages/core/src/artifact-qa.js';
import { readFixture } from '../fixtures/read-fixture.js';

const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ne-psd-artifact-qa-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'exports'));
  await mkdir(join(root, 'trace'));
  const job = structuredClone(readFixture<JobSpec>('job.interactive.json'));
  job.profile.output = { format: 'png', quality: 90, colorSpace: 'sRGB', width: 100, height: 50 };
  job.profile.fitMode = 'cover';
  const source = await sharp({ create: { width: 20, height: 10, channels: 4, background: '#70a0d0' } }).png().toBuffer();
  await writeFile(join(root, 'source.png'), source);
  const asset = { ...job.assets[0]!, source: { ...job.assets[0]!.source, sha256: digest(source) }, sourceBytes: source.length };
  const request: RenderRequest = { schemaVersion: 1, jobId: job.jobId, asset, profile: job.profile, attempt: 1, stagingDirectory: root };
  const output = await sharp({ create: { width: 100, height: 50, channels: 4, background: '#70a0d0' } }).png().toBuffer();
  const artifacts: VariantArtifact[] = [];
  for (const variantId of ['1', '2', '3'] as const) {
    const path = `exports/${variantId}.png`;
    await writeFile(join(root, path), output);
    artifacts.push({ variantId, path, sha256: digest(output), bytes: output.length, colorSpace: 'sRGB', width: 100, height: 50, format: 'png' });
  }
  const inputDigests: Record<string, string> = { 'source.png': digest(source) };
  for (const path of ['trace/document.json', 'trace/tool.json', 'trace/check.json']) {
    const bytes = Buffer.from(JSON.stringify({ path, observed: true }));
    await writeFile(join(root, path), bytes);
    inputDigests[path] = digest(bytes);
  }
  const target = job.profile.targets[0]!.target;
  const evidence: RenderEvidence = {
    schemaVersion: 1, jobId: job.jobId, assetId: asset.assetId, attempt: 1,
    profileSha256: job.profile.profileSha256, sourceSha256: asset.source.sha256,
    toolSchemaSha256: job.profile.toolSchemaSha256,
    geometry: [{ target, reference: { left: 0, top: 0, right: 100, bottom: 50 }, placed: { left: 0, top: 0, right: 100, bottom: 50 }, fitMode: 'cover', clipped: true, adjacentToReference: true }],
    visibility: (['1', '2', '3'] as const).map((variantId) => ({ variantId, visibleVariantIds: [variantId] })),
    artifacts: artifacts as RenderEvidence['artifacts'],
    checks: [{ id: 'IMAGE.DECODE_FORMAT', passed: true, evidencePath: 'trace/check.json' }],
    documentTracePath: 'trace/document.json', toolTracePath: 'trace/tool.json',
  };
  const input: ArtifactQaInput = {
    request, evidence, expectedReviewPolicySha256: job.reviewPolicySha256,
    sourceRelativePath: 'source.png', evidenceInputDigests: inputDigests,
    exportsRelativeDirectory: 'exports',
    fitTolerance: { qualificationId: job.profile.qualificationId, profileSha256: job.profile.profileSha256, pixels: 0.25 },
  };
  const replaceArtifact = async (id: '1' | '2' | '3', bytes: Buffer) => {
    const artifact = evidence.artifacts.find((item) => item.variantId === id)!;
    await writeFile(join(root, artifact.path), bytes);
    artifact.sha256 = digest(bytes);
    artifact.bytes = bytes.length;
  };
  return { root, input, request, evidence, replaceArtifact };
}

describe('deterministic artifact QA', () => {
  it('checks all three real images and returns quality as unqualified with duplicate pixels diagnostic', async () => {
    const f = await fixture();
    const result = await verifyArtifactQa(f.input);
    expect(result.artifactChecksPassed).toBe(true);
    expect(result.requirementResults).toMatchObject({
      'ARTIFACTS.EXACTLY_THREE': 'pass', 'IMAGE.DECODE_FORMAT': 'pass',
      'IMAGE.DIMENSIONS_COLOR': 'pass', 'IMAGE.QUALITY': 'unknown',
      'GEOMETRY.REQUESTED_FIT': 'unknown', 'VARIANTS.VISIBILITY': 'unknown',
    });
    expect(result.artifacts.map((item) => item.variantId)).toEqual(['1', '2', '3']);
    expect(result.diagnostics).toContain('DUPLICATE_EXPORT_BYTES');
    expect(result.bindings.reviewPolicySha256).toBe(f.input.expectedReviewPolicySha256);
  });

  it('rejects a changed export despite producer passed=true evidence', async () => {
    const f = await fixture();
    await writeFile(join(f.root, 'exports/1.png'), Buffer.from('changed'));
    await expect(verifyArtifactQa(f.input)).rejects.toMatchObject({ code: 'ARTIFACT_DIGEST_MISMATCH' });
  });

  it('fully decodes every export after its digest matches', async () => {
    const f = await fixture();
    await f.replaceArtifact('2', Buffer.from('not an image'));
    await expect(verifyArtifactQa(f.input)).rejects.toMatchObject({ code: 'IMAGE_DECODE_FAILED' });
  });

  it('checks measured format and dimensions against the profile', async () => {
    const f = await fixture();
    await f.replaceArtifact('2', await sharp({ create: { width: 99, height: 50, channels: 3, background: '#000' } }).png().toBuffer());
    await expect(verifyArtifactQa(f.input)).rejects.toMatchObject({ code: 'IMAGE_SPEC_MISMATCH' });
    await f.replaceArtifact('2', await sharp({ create: { width: 100, height: 50, channels: 3, background: '#000' } }).jpeg().toBuffer());
    await expect(verifyArtifactQa(f.input)).rejects.toMatchObject({ code: 'IMAGE_SPEC_MISMATCH' });
  });

  it('rejects an actual CMYK JPEG when sRGB JPEG was requested', async () => {
    const f = await fixture();
    f.request.profile.output.format = 'jpeg';
    for (const artifact of f.evidence.artifacts) {
      artifact.format = 'jpeg';
      await f.replaceArtifact(artifact.variantId, await sharp({ create: { width: 100, height: 50, channels: 3, background: '#70a0d0' } }).jpeg().toBuffer());
    }
    const cmyk = await sharp({ create: { width: 100, height: 50, channels: 3, background: '#70a0d0' } }).toColourspace('cmyk').jpeg().toBuffer();
    await f.replaceArtifact('2', cmyk);
    await expect(verifyArtifactQa(f.input)).rejects.toMatchObject({ code: 'IMAGE_SPEC_MISMATCH' });
  });

  it('rejects duplicate, missing, and extra export paths', async () => {
    const f = await fixture();
    f.evidence.artifacts[1]!.path = 'exports/1.png';
    await expect(verifyArtifactQa(f.input)).rejects.toMatchObject({ code: 'ARTIFACT_SET_INVALID' });
    f.evidence.artifacts[1]!.path = 'exports/2.png';
    await rm(join(f.root, 'exports/3.png'));
    await expect(verifyArtifactQa(f.input)).rejects.toMatchObject({ code: 'ARTIFACT_SET_INVALID' });
    await writeFile(join(f.root, 'exports/3.png'), await readFile(join(f.root, 'exports/2.png')));
    await writeFile(join(f.root, 'exports/partial.png'), Buffer.from('partial'));
    await expect(verifyArtifactQa(f.input)).rejects.toMatchObject({ code: 'ARTIFACT_SET_INVALID' });
  });

  it('rejects path traversal and a symlink escape', async () => {
    const f = await fixture();
    f.evidence.artifacts[0]!.path = '../outside.png';
    await expect(verifyArtifactQa(f.input)).rejects.toMatchObject({ code: 'SCHEMA_INVALID' });
    f.evidence.artifacts[0]!.path = 'exports/1.png';
    await rm(join(f.root, 'exports/1.png'));
    await symlink(join(f.root, 'source.png'), join(f.root, 'exports/1.png'));
    await expect(verifyArtifactQa(f.input)).rejects.toMatchObject({ code: 'PATH_UNSAFE' });
  });

  it('rehashes source and trace inputs against trusted expected digests', async () => {
    const f = await fixture();
    await writeFile(join(f.root, 'trace/tool.json'), '{}');
    await expect(verifyArtifactQa(f.input)).rejects.toMatchObject({ code: 'EVIDENCE_INPUT_MISMATCH' });
    const source = await readFile(join(f.root, 'source.png'));
    f.input.evidenceInputDigests['trace/tool.json'] = digest('{}');
    await writeFile(join(f.root, 'source.png'), Buffer.concat([source, Buffer.from('x')]));
    await expect(verifyArtifactQa(f.input)).rejects.toMatchObject({ code: 'EVIDENCE_INPUT_MISMATCH' });
  });

  it('rejects mismatched job, asset, attempt, profile, tool, and policy bindings', async () => {
    for (const mutate of [
      (f: Awaited<ReturnType<typeof fixture>>) => { f.evidence.jobId = 'other'; },
      (f: Awaited<ReturnType<typeof fixture>>) => { f.evidence.assetId = 'other'; },
      (f: Awaited<ReturnType<typeof fixture>>) => { f.evidence.attempt = 2; },
      (f: Awaited<ReturnType<typeof fixture>>) => { f.evidence.profileSha256 = 'a'.repeat(64); },
      (f: Awaited<ReturnType<typeof fixture>>) => { f.evidence.toolSchemaSha256 = 'a'.repeat(64); },
      (f: Awaited<ReturnType<typeof fixture>>) => { f.input.expectedReviewPolicySha256 = 'bad'; },
    ]) {
      const f = await fixture();
      mutate(f);
      await expect(verifyArtifactQa(f.input)).rejects.toMatchObject({ code: 'BINDING_MISMATCH' });
    }
  });

  it('checks cover geometry with measured source aspect and qualified tolerance', async () => {
    const f = await fixture();
    f.evidence.geometry[0]!.placed.right = 90;
    await expect(verifyArtifactQa(f.input)).rejects.toMatchObject({ code: 'GEOMETRY_MISMATCH' });
    f.evidence.geometry[0]!.placed.right = 100;
    f.evidence.geometry[0]!.clipped = false;
    await expect(verifyArtifactQa(f.input)).rejects.toMatchObject({ code: 'GEOMETRY_MISMATCH' });
    f.evidence.geometry[0]!.clipped = true;
    f.input.fitTolerance.qualificationId = 'unqualified';
    await expect(verifyArtifactQa(f.input)).rejects.toMatchObject({ code: 'GEOMETRY_MISMATCH' });
  });

  it('refuses an unbound or excessively loose fit tolerance', async () => {
    const f = await fixture();
    f.input.fitTolerance.profileSha256 = 'a'.repeat(64);
    await expect(verifyArtifactQa(f.input)).rejects.toMatchObject({ code: 'GEOMETRY_MISMATCH' });
    f.input.fitTolerance.profileSha256 = f.request.profile.profileSha256;
    f.input.fitTolerance.pixels = 1000;
    await expect(verifyArtifactQa(f.input)).rejects.toMatchObject({ code: 'GEOMETRY_MISMATCH' });
  });

  it('checks contain and stretch bounds against decoded source dimensions', async () => {
    const f = await fixture();
    const geometry = f.evidence.geometry[0]!;
    geometry.reference.bottom = 100;
    f.request.profile.fitMode = 'contain';
    geometry.fitMode = 'contain';
    geometry.placed = { left: 0, top: 25, right: 100, bottom: 75 };
    expect((await verifyArtifactQa(f.input)).artifactChecksPassed).toBe(true);
    f.request.profile.fitMode = 'stretch';
    geometry.fitMode = 'stretch';
    geometry.placed = { left: 0, top: 0, right: 100, bottom: 100 };
    expect((await verifyArtifactQa(f.input)).artifactChecksPassed).toBe(true);
    geometry.placed.right = 99;
    await expect(verifyArtifactQa(f.input)).rejects.toMatchObject({ code: 'GEOMETRY_MISMATCH' });
  });

  it('rejects a variant with another visible group even if its export decodes', async () => {
    const f = await fixture();
    f.evidence.visibility[1]!.visibleVariantIds.push('1');
    await expect(verifyArtifactQa(f.input)).rejects.toMatchObject({ code: 'VISIBILITY_MISMATCH' });
  });

  it('accepts a profile-bound calibration that permits legitimate uniform and identical exports', async () => {
    const f = await fixture();
    f.input.qualityCalibration = {
      qualificationId: f.request.profile.qualificationId, profileSha256: f.request.profile.profileSha256,
      maxFirstPixelMatchFraction: 1, minOpaquePixelFraction: 0, maxIdenticalPairCount: 3,
    };
    const result = await verifyArtifactQa(f.input);
    expect(result.requirementResults['IMAGE.QUALITY']).toBe('pass');
    expect(result.diagnostics).toContain('DUPLICATE_EXPORT_BYTES');
  });

  it('fails only the explicitly calibrated uniformity or duplicate limit', async () => {
    const f = await fixture();
    f.input.qualityCalibration = {
      qualificationId: f.request.profile.qualificationId, profileSha256: f.request.profile.profileSha256,
      maxFirstPixelMatchFraction: 0.9, minOpaquePixelFraction: 0, maxIdenticalPairCount: 3,
    };
    await expect(verifyArtifactQa(f.input)).rejects.toMatchObject({ code: 'IMAGE_QUALITY_FAILED' });
    f.input.qualityCalibration.maxFirstPixelMatchFraction = 1;
    f.input.qualityCalibration.maxIdenticalPairCount = 0;
    await expect(verifyArtifactQa(f.input)).rejects.toMatchObject({ code: 'IMAGE_QUALITY_FAILED' });
  });

  it('enforces a calibrated opaque-pixel fraction using decoded alpha', async () => {
    const f = await fixture();
    f.input.qualityCalibration = {
      qualificationId: f.request.profile.qualificationId, profileSha256: f.request.profile.profileSha256,
      maxFirstPixelMatchFraction: 1, minOpaquePixelFraction: 0.9, maxIdenticalPairCount: 3,
    };
    await f.replaceArtifact('3', await sharp({ create: { width: 100, height: 50, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 0 } } }).png().toBuffer());
    await expect(verifyArtifactQa(f.input)).rejects.toMatchObject({ code: 'IMAGE_QUALITY_FAILED' });
  });

  it('requires quality thresholds to belong to the sealed profile and be bounded', async () => {
    const f = await fixture();
    f.input.qualityCalibration = {
      qualificationId: 'other', profileSha256: f.request.profile.profileSha256,
      maxFirstPixelMatchFraction: 1, minOpaquePixelFraction: 0, maxIdenticalPairCount: 3,
    };
    await expect(verifyArtifactQa(f.input)).rejects.toMatchObject({ code: 'IMAGE_QUALITY_UNQUALIFIED' });
    f.input.qualityCalibration.qualificationId = f.request.profile.qualificationId;
    f.input.qualityCalibration.minOpaquePixelFraction = 1.1;
    await expect(verifyArtifactQa(f.input)).rejects.toMatchObject({ code: 'IMAGE_QUALITY_UNQUALIFIED' });
  });
});
