import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it, onTestFinished } from 'vitest';
import { bundleDigest, sha256Json, type EvidenceBundleManifest, type JobSpec, type ModelProfile, type RenderEvidence, type ReviewDecision, type ReviewPolicy } from '@ne-psd/contracts';
import { gateAutomatedReview } from '../../packages/core/src/review-gate.js';
import { readFixture } from '../fixtures/read-fixture.js';

const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ne-psd-review-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const job = structuredClone(readFixture<JobSpec>('job.interactive.json'));
  const policy = structuredClone(readFixture<ReviewPolicy>('policy.v1.json'));
  policy.policySha256 = sha256Json(policy, { excludeKeys: ['policySha256'] });
  const planner = structuredClone(readFixture<ModelProfile>('model.local.json'));
  const reviewer = structuredClone(planner);
  reviewer.profileId = 'selected-vision-reviewer';
  job.modelProfileId = planner.profileId;
  job.reviewerModelProfileId = reviewer.profileId;
  job.reviewPolicySha256 = policy.policySha256;
  const image = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#226688' } }).png().toBuffer();
  const detail = await sharp(image).extract({ left: 0, top: 0, width: 1, height: 1 }).png().toBuffer();
  job.assets[0]!.source.sha256 = hash(image);
  job.assets[0]!.sourceBytes = image.length;
  const files = [] as EvidenceBundleManifest['files'][number][];
  const visionInputs = [] as EvidenceBundleManifest['visionInputs'];
  const artifacts = [] as RenderEvidence['artifacts'][number][];
  const add = async (path: string, bytes: Buffer, role: EvidenceBundleManifest['files'][number]['role']) => {
    await writeFile(join(root, path), bytes);
    files.push({ relativePath: path, role, sha256: hash(bytes), bytes: bytes.length });
  };
  await add('source.png', image, 'imageInput');
  visionInputs.push({ id: 'source', role: 'source', relativePath: 'source.png', sha256: hash(image), width: 2, height: 2,
    variantId: null, derivedFromSha256: hash(image), crop: null });
  for (const id of ['1', '2', '3'] as const) {
    const path = `variant-${id}.png`;
    const ref = `reference-${id}.png`, cropPath = `detail-${id}.png`;
    await add(path, image, 'artifact');
    await add(ref, image, 'imageInput');
    await add(cropPath, detail, 'imageInput');
    artifacts.push({ variantId: id, path, sha256: hash(image), bytes: image.length, colorSpace: 'sRGB', width: 2, height: 2, format: 'png' });
    visionInputs.push({ id: `output-${id}`, role: 'output', relativePath: path, sha256: hash(image), width: 2, height: 2, variantId: id, derivedFromSha256: hash(image), crop: null });
    visionInputs.push({ id: `reference-${id}`, role: 'reference', relativePath: ref, sha256: hash(image), width: 2, height: 2, variantId: id, derivedFromSha256: hash(image), crop: null });
    visionInputs.push({ id: `detail-${id}`, role: 'detail', relativePath: cropPath, sha256: hash(detail), width: 1, height: 1, variantId: id,
      derivedFromSha256: hash(image), crop: { left: 0, top: 0, right: 1, bottom: 1 } });
  }
  await add('document.json', Buffer.from('{}'), 'trace');
  await add('tool.json', Buffer.from('{}'), 'trace');
  await add('check.json', Buffer.from('{}'), 'check');
  await add('render-evidence.json', Buffer.from('{}'), 'renderEvidence');
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const manifest: EvidenceBundleManifest = { schemaVersion: 1, jobId: job.jobId, assetId: job.assets[0]!.assetId, attempt: 1, files, visionInputs };
  const evidence: RenderEvidence = { schemaVersion: 1, jobId: job.jobId, assetId: manifest.assetId, attempt: 1,
    profileSha256: job.profile.profileSha256, sourceSha256: job.assets[0]!.source.sha256, toolSchemaSha256: job.profile.toolSchemaSha256,
    artifacts: artifacts as RenderEvidence['artifacts'], geometry: [], visibility: [], checks: [{ id: 'check', passed: true, evidencePath: 'check.json' }], documentTracePath: 'document.json', toolTracePath: 'tool.json' };
  const result: ReviewDecision = { schemaVersion: 1, reviewId: 'review-one', jobId: job.jobId, assetId: manifest.assetId, attempt: 1,
    evidenceSha256: bundleDigest(manifest), sessionId: 'fresh-session', promptSha256: policy.promptSha256,
    modelId: reviewer.modelId, modelProvenance: reviewer.provenance, reviewerVersion: 'reviewer-v1', reviewPolicySha256: policy.policySha256,
    verdict: 'pass', checks: policy.requirements.map((requirement) => ({ requirementId: requirement.id, result: 'pass', evidenceRefs: artifacts.map((item) => item.path), reason: 'verified' })),
    variantChecks: artifacts.map((item) => ({ variantId: item.variantId, verdict: 'pass', evidenceRefs: [item.path], reason: 'visible pixels verified' })) as ReviewDecision['variantChecks'], findings: [] };
  const qa = { artifactChecksPassed: true as const, requirementResults: {
    'ARTIFACTS.EXACTLY_THREE': 'pass', 'IMAGE.DECODE_FORMAT': 'pass', 'IMAGE.DIMENSIONS_COLOR': 'pass', 'IMAGE.QUALITY': 'pass',
    'BINDING.CURRENT_ATTEMPT': 'unknown', 'GEOMETRY.REQUESTED_FIT': 'unknown', 'CLIPPING.ALPHA_ADJACENCY': 'unknown', 'VARIANTS.VISIBILITY': 'unknown', 'EVIDENCE.TRACE_COMPLETE': 'unknown',
  } as const, artifacts: artifacts.map((item) => ({ ...item, pixelSha256: hash(image), pixelBytes: image.length, hasAlpha: false, firstPixelMatchFraction: 0, opaquePixelFraction: 1 })),
  diagnostics: [], bindings: { jobId: job.jobId, assetId: manifest.assetId, attempt: 1, profileSha256: job.profile.profileSha256,
    sourceSha256: job.assets[0]!.source.sha256, toolSchemaSha256: job.profile.toolSchemaSha256, reviewPolicySha256: policy.policySha256 } };
  const validatedProofResults = Object.fromEntries(policy.requirements.filter((item) => item.evaluator === 'deterministic').map((item) => [item.id, 'pass' as const]));
  const reviewerService = { review: async () => result };
  const input = { bundleRoot: root, job, evidence, manifest, policy, qa, validatedProofResults,
    expectedProfiles: { plannerSha256: sha256Json(planner), reviewerSha256: sha256Json(reviewer) },
    resolveQualifiedProfile: async (id: string) => ({ profile: id === reviewer.profileId ? reviewer : planner, qualifiedVision: true }),
    usedSessionIds: new Set<string>(), reviewer: reviewerService, signal: new AbortController().signal };
  return { root, job, policy, planner, reviewer, manifest, evidence, result, qa, input };
}

describe('automated review gate', () => {
  it('accepts only the selected qualified reviewer with all mandatory checks and three passes', async () => {
    const f = await fixture();
    const outcome = await gateAutomatedReview(f.input);
    expect(outcome.status).toBe('passed');
  });
  it('blocks unknown deterministic quality before calling reviewer', async () => {
    const f = await fixture();
    f.qa.requirementResults['IMAGE.QUALITY'] = 'unknown' as never;
    let called = false;
    f.input.reviewer.review = async () => { called = true; return f.result; };
    expect((await gateAutomatedReview(f.input)).status).toBe('blocked');
    expect(called).toBe(false);
  });
  it('blocks an unknown mandatory B proof even if the model would pass it', async () => {
    const f = await fixture();
    f.input.validatedProofResults['SAFETY.ORIGINALS_UNCHANGED'] = 'unknown';
    let called = false;
    f.input.reviewer.review = async () => { called = true; return f.result; };
    expect(await gateAutomatedReview(f.input)).toMatchObject({ status: 'blocked', reason: 'SAFETY.ORIGINALS_UNCHANGED is unknown' });
    expect(called).toBe(false);
  });
  it('rejects a manifest with missing vision evidence', async () => {
    const f = await fixture();
    f.manifest.visionInputs = [];
    await expect(gateAutomatedReview(f.input)).rejects.toThrow(/vision|reference|detail/i);
  });
  it('rejects profile, provenance, prompt and reused session mismatches', async () => {
    for (const mutate of [
      (f: Awaited<ReturnType<typeof fixture>>) => { f.job.reviewerModelProfileId = 'wrong'; },
      (f: Awaited<ReturnType<typeof fixture>>) => { f.result.modelProvenance = { ...f.result.modelProvenance, kind: 'remote' } as never; },
      (f: Awaited<ReturnType<typeof fixture>>) => { f.result.promptSha256 = 'a'.repeat(64); },
      (f: Awaited<ReturnType<typeof fixture>>) => { f.input.usedSessionIds.add('fresh-session'); },
    ]) {
      const f = await fixture(); mutate(f);
      await expect(gateAutomatedReview(f.input)).rejects.toThrow();
    }
  });
  it('blocks an individual variant failure despite aggregate pass', async () => {
    const f = await fixture();
    f.result.variantChecks[1]!.verdict = 'fail';
    await expect(gateAutomatedReview(f.input)).rejects.toThrow(/variant|pass/i);
  });
  it('retains the sealed staged bundle on reviewer outage and detects drift', async () => {
    const f = await fixture();
    f.input.reviewer.review = async () => { throw new Error('offline'); };
    const pending = await gateAutomatedReview(f.input);
    expect(pending).toMatchObject({ status: 'pendingReview', bundleRoot: f.root, evidenceSha256: bundleDigest(f.manifest) });
    await writeFile(join(f.root, 'variant-1.png'), 'changed');
    await expect(gateAutomatedReview(f.input)).rejects.toThrow(/changed/i);
  });
  it('rejects evidence changed during the review call', async () => {
    const f = await fixture();
    f.input.reviewer.review = async () => {
      await writeFile(join(f.root, 'variant-2.png'), 'changed');
      return f.result;
    };
    await expect(gateAutomatedReview(f.input)).rejects.toThrow(/changed/i);
  });
});
