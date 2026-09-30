import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it, onTestFinished } from 'vitest';
import { sha256Json, type JobSpec, type RenderEvidence, type RenderRequest, type ReviewPolicy } from '@ne-psd/contracts';
import { buildEvidenceBundle } from '../../packages/core/src/evidence-bundle.js';
import { acceptVisualAttestation, prepareVisualReviewRequest, sealAttestedManifest } from '../../packages/core/src/visual-attestation.js';
import { readFixture } from '../fixtures/read-fixture.js';
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ne-psd-attestation-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['exports', 'references', 'details', 'trace']) await mkdir(join(root, dir));
  const source = await sharp({ create: { width: 4, height: 4, channels: 4, background: '#102030' } }).png().toBuffer();
  const job = structuredClone(readFixture<JobSpec>('job.interactive.json'));
  const policy = structuredClone(readFixture<ReviewPolicy>('policy.v1.json'));
  policy.visualGate = 'humanPerAsset';
  policy.requirements = policy.requirements.map((item) => item.id === 'VISUAL.QUALIFIED' ? { ...item, evaluator: 'human' as const } : item);
  policy.policySha256 = sha256Json(policy, { excludeKeys: ['policySha256'] });
  job.reviewPolicySha256 = policy.policySha256;
  job.assets[0]!.source.sha256 = hash(source);
  job.assets[0]!.sourceBytes = source.length;
  await writeFile(join(root, 'source.png'), source);
  const request: RenderRequest = { schemaVersion: 1, jobId: job.jobId, asset: job.assets[0]!, profile: job.profile, attempt: 1, stagingDirectory: root };
  const artifacts = [] as RenderEvidence['artifacts'][number][];
  const references = [] as Array<{ variantId: '1' | '2' | '3'; path: string; sha256: string; qualificationId: string }>;
  const details = [] as Array<{ variantId: '1' | '2' | '3'; path: string; derivedFromPath: string; crop: { left: number; top: number; right: number; bottom: number } }>;
  for (const id of ['1', '2', '3'] as const) {
    const path = `exports/${id}.png`, ref = `references/${id}.png`, cropPath = `details/${id}.png`;
    const output = await sharp({ create: { width: 4, height: 4, channels: 4, background: { '1': '#a02020', '2': '#20a020', '3': '#2020a0' }[id] } }).png().toBuffer();
    const reference = await sharp({ create: { width: 4, height: 4, channels: 4, background: { '1': '#b07010', '2': '#10b070', '3': '#7010b0' }[id] } }).png().toBuffer();
    const detail = await sharp(output).extract({ left: 1, top: 1, width: 2, height: 2 }).png().toBuffer();
    await writeFile(join(root, path), output);
    await writeFile(join(root, ref), reference);
    await writeFile(join(root, cropPath), detail);
    artifacts.push({ variantId: id, path, sha256: hash(output), bytes: output.length, colorSpace: 'sRGB', width: 4, height: 4, format: 'png' });
    references.push({ variantId: id, path: ref, sha256: hash(reference), qualificationId: job.profile.qualificationId });
    details.push({ variantId: id, path: cropPath, derivedFromPath: path, crop: { left: 1, top: 1, right: 3, bottom: 3 } });
  }
  for (const path of ['trace/document.json', 'trace/tool.json', 'trace/check.json']) await writeFile(join(root, path), JSON.stringify({ path }));
  const evidence: RenderEvidence = { schemaVersion: 1, jobId: job.jobId, assetId: job.assets[0]!.assetId, attempt: 1,
    profileSha256: job.profile.profileSha256, sourceSha256: hash(source), toolSchemaSha256: job.profile.toolSchemaSha256,
    artifacts: artifacts as RenderEvidence['artifacts'], geometry: [], visibility: [], checks: [{ id: 'check', passed: true, evidencePath: 'trace/check.json' }],
    documentTracePath: 'trace/document.json', toolTracePath: 'trace/tool.json' };
  await writeFile(join(root, 'render-evidence.json'), JSON.stringify(evidence));
  const bundle = await buildEvidenceBundle({ root, request, evidence, sourcePath: 'source.png', references, details });
  const binding = { plannerProfileSha256: 'a'.repeat(64), reviewerProfileSha256: 'b'.repeat(64) };
  const state = { root, job, policy, evidence, manifest: bundle.manifest, currentAttempt: 1 as const,
    currentRequestId: null as string | null, qualifiedReferences: Object.fromEntries(references.map((item) => [item.variantId, item.sha256])), ...binding };
  return { root, job, policy, evidence, source, state };
}

describe('manual visual attestation', () => {
  it('creates a lossless contact sheet with every full output, qualified reference and detail visible', async () => {
    const f = await fixture();
    const prepared = await prepareVisualReviewRequest(f.state);
    expect(prepared.request.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(prepared.request.artifacts.map((item) => item.variantId)).toEqual(['1', '2', '3']);
    expect(prepared.contentManifest.files.find((item) => item.relativePath === prepared.request.contactSheet.relativePath)?.sha256).toBe(prepared.request.contactSheet.sha256);
    expect(prepared.layout).toHaveLength(9);
    const sheet = await readFile(join(f.root, prepared.request.contactSheet.relativePath));
    for (const panel of prepared.layout) {
      const actual = await sharp(sheet).extract({ left: panel.left, top: panel.top, width: panel.width, height: panel.height }).ensureAlpha().raw().toBuffer();
      const original = await sharp(await readFile(join(f.root, panel.relativePath))).ensureAlpha().raw().toBuffer();
      expect(actual.equals(original)).toBe(true);
    }
  });
  it('accepts only current bound request with trusted actor, and makes identical replay idempotent', async () => {
    const f = await fixture();
    const prepared = await prepareVisualReviewRequest(f.state);
    f.state.currentRequestId = prepared.request.requestId;
    const input = { state: { ...f.state, manifest: prepared.contentManifest }, request: prepared.request,
      storedProfiles: { plannerModelProfileId: f.job.modelProfileId, reviewerModelProfileId: f.job.reviewerModelProfileId, plannerProfileSha256: f.state.plannerProfileSha256, reviewerProfileSha256: f.state.reviewerProfileSha256 },
      submission: { requestId: prepared.request.requestId, decision: 'approve' as const, notes: 'All variants checked' },
      trustedActorIdentity: 'main/operator-1', nowMs: Date.parse('2026-09-30T10:00:00.000Z'), expiresAt: '2026-09-30T11:00:00.000Z' };
    const accepted = await acceptVisualAttestation(input);
    expect(accepted.status).toBe('accepted');
    expect(accepted.attestation.operatorIdentity).toBe('main/operator-1');
    await writeFile(join(f.root, accepted.file.relativePath), accepted.bytes);
    const receipt = { consumed: true as const, requestId: prepared.request.requestId, attestationSha256: accepted.file.sha256 };
    const sealed = await sealAttestedManifest(f.root, prepared.contentManifest, accepted, receipt);
    expect(sealed.files.find((file) => file.role === 'humanAttestation')?.sha256).toBe(accepted.file.sha256);
    expect((await acceptVisualAttestation({ ...input, existing: accepted.attestation })).status).toBe('idempotent');
    await expect(acceptVisualAttestation({ ...input, existing: accepted.attestation, submission: { ...input.submission, notes: 'changed' } })).rejects.toThrow(/conflict/i);
  });
  it('rejects drift, stale attempt, actor spoofing and a rejected decision as publication approval', async () => {
    const f = await fixture();
    const prepared = await prepareVisualReviewRequest(f.state);
    f.state.currentRequestId = prepared.request.requestId;
    const base = { state: { ...f.state, manifest: prepared.contentManifest }, request: prepared.request,
      storedProfiles: { plannerModelProfileId: f.job.modelProfileId, reviewerModelProfileId: f.job.reviewerModelProfileId, plannerProfileSha256: f.state.plannerProfileSha256, reviewerProfileSha256: f.state.reviewerProfileSha256 },
      submission: { requestId: prepared.request.requestId, decision: 'approve' as const, notes: '' }, trustedActorIdentity: 'main/operator-1',
      nowMs: Date.parse('2026-09-30T10:00:00.000Z'), expiresAt: '2026-09-30T11:00:00.000Z' };
    await expect(acceptVisualAttestation({ ...base, submission: { ...base.submission, operatorIdentity: 'forged' } as never })).rejects.toThrow(/submission|actor/i);
    await expect(acceptVisualAttestation({ ...base, state: { ...base.state, currentAttempt: 2 as const } })).rejects.toThrow(/stale|attempt/i);
    const rejected = await acceptVisualAttestation({ ...base, submission: { ...base.submission, decision: 'reject' as const } });
    expect(rejected.authorizesPublication).toBe(false);
    await expect(sealAttestedManifest(f.root, prepared.contentManifest, rejected,
      { consumed: true, requestId: prepared.request.requestId, attestationSha256: rejected.file.sha256 })).rejects.toThrow(/reject|approv/i);
    await writeFile(join(f.root, 'exports/2.png'), 'changed');
    await expect(acceptVisualAttestation(base)).rejects.toThrow(/changed|drift/i);
  });
  it('rejects changed model selection and contact-sheet bytes', async () => {
    const f = await fixture();
    const prepared = await prepareVisualReviewRequest(f.state);
    f.state.currentRequestId = prepared.request.requestId;
    const base = { state: { ...f.state, manifest: prepared.contentManifest }, request: prepared.request,
      storedProfiles: { plannerModelProfileId: f.job.modelProfileId, reviewerModelProfileId: f.job.reviewerModelProfileId,
        plannerProfileSha256: f.state.plannerProfileSha256, reviewerProfileSha256: f.state.reviewerProfileSha256 },
      submission: { requestId: prepared.request.requestId, decision: 'approve' as const, notes: '' }, trustedActorIdentity: 'main/operator-1',
      nowMs: Date.parse('2026-09-30T10:00:00.000Z'), expiresAt: '2026-09-30T11:00:00.000Z' };
    await expect(acceptVisualAttestation({ ...base, storedProfiles: { ...base.storedProfiles, reviewerModelProfileId: 'changed' } })).rejects.toThrow(/model profile/i);
    await writeFile(join(f.root, prepared.request.contactSheet.relativePath), 'changed');
    await expect(acceptVisualAttestation(base)).rejects.toThrow(/changed|drift/i);
  });
});
