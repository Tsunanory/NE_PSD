import { afterEach, describe, expect, it } from 'vitest';
import { rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bundleDigest, sha256Bytes } from '@ne-psd/contracts';
import { EvidenceValidator } from '../../packages/intelligence/dist/review/evidence-validator.js';
import { prepareEvidenceRequest } from '../../packages/intelligence/dist/review/evidence-request.js';
import { validateVisualAttestation } from '../../packages/intelligence/dist/review/visual-attestation.js';
import { createReviewFixture } from './helpers/review-fixture.js';

const roots: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of roots.splice(0)) await close(); });
const fixture = async (gate: 'qualifiedVisionReviewer' | 'humanPerAsset' = 'qualifiedVisionReviewer') => { const value = await createReviewFixture(gate); roots.push(value.close); return value; };
const limits = { maxFiles: 40, maxFileBytes: 1024 * 1024, maxTotalBytes: 10 * 1024 * 1024 };
const validator = (value: Awaited<ReturnType<typeof fixture>>, override = limits) => new EvidenceValidator(async () => value.state, override);
const validate = (value: Awaited<ReturnType<typeof fixture>>, root = value.root) => validator(value).validate({ bundleRoot: root, manifest: value.manifest, evidence: value.evidence, policy: value.policy });
const reseal = (value: Awaited<ReturnType<typeof fixture>>) => { value.state.sealedEvidenceSha256 = bundleDigest(value.manifest); };

describe('sealed evidence integrity', () => {
  it('retains every image as digest-bound bytes and survives a complete directory rename', async () => {
    const value = await fixture(); const moved = `${value.root}-moved`; await rename(value.root, moved); roots.push(async () => { const { rm } = await import('node:fs/promises'); await rm(moved, { recursive: true, force: true }); });
    const snapshot = await validate(value, moved);
    expect(snapshot.evidenceSha256).toBe(bundleDigest(value.manifest));
    const prepared = await prepareEvidenceRequest(snapshot);
    expect(prepared.images).toHaveLength(10);
    expect(prepared.userData.evidenceSha256).toBe(snapshot.evidenceSha256);
    for (const image of prepared.images) expect(sha256Bytes(image.bytes)).toBe(image.sha256);
    const copy = snapshot.getBytes('outputs/1.png'); copy[0] ^= 0xff;
    expect(sha256Bytes(snapshot.getBytes('outputs/1.png'))).toBe(value.evidence.artifacts[0].sha256);
    await snapshot.assertUnchanged();
  });
  it('rejects a changed artifact after validation and before publication', async () => {
    const value = await fixture(); const snapshot = await validate(value);
    await writeFile(join(value.root, 'outputs/2.png'), 'mutated artifact');
    await expect(snapshot.assertUnchanged()).rejects.toThrow(/changed|digest|size/);
    await expect(prepareEvidenceRequest(snapshot)).rejects.toThrow();
  });
  it('rejects a changed trusted seal after validation', async () => {
    const value = await fixture(); const snapshot = await validate(value);
    value.state.sealedEvidenceSha256 = 'b'.repeat(64);
    await expect(snapshot.assertUnchanged()).rejects.toThrow(/trusted seal changed/);
  });
  it('does not expose mutable validated metadata or retained bytes', async () => {
    const value = await fixture(); const snapshot = await validate(value);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.manifest.files[0])).toBe(true);
    const output = snapshot.getBytes('outputs/1.png'); output.fill(0);
    expect(sha256Bytes(snapshot.getBytes('outputs/1.png'))).toBe(value.evidence.artifacts[0].sha256);
  });
  it('rejects a stale attempt even with a resealed manifest', async () => {
    const value = await fixture(); value.manifest.attempt = 2; value.evidence.attempt = 2; reseal(value);
    await expect(validate(value)).rejects.toThrow(/current attempt/);
  });
  it('rejects changed job, source, profile, tool, and policy bindings separately', async () => {
    for (const mutate of [
      (v: Awaited<ReturnType<typeof fixture>>) => { v.evidence.jobId = 'other-job'; },
      (v: Awaited<ReturnType<typeof fixture>>) => { v.evidence.sourceSha256 = 'b'.repeat(64); },
      (v: Awaited<ReturnType<typeof fixture>>) => { v.evidence.profileSha256 = 'b'.repeat(64); },
      (v: Awaited<ReturnType<typeof fixture>>) => { v.evidence.toolSchemaSha256 = 'b'.repeat(64); },
      (v: Awaited<ReturnType<typeof fixture>>) => { v.job.reviewPolicySha256 = 'b'.repeat(64); v.state.job = v.job; },
    ]) { const value = await fixture(); mutate(value); await expect(validate(value)).rejects.toThrow(); }
  });
  it('rejects missing render evidence, trace and check reports', async () => {
    for (const path of ['render-evidence.json', 'traces/document.json', 'traces/tool.json', 'reports/qa.json']) {
      const value = await fixture(); value.manifest.files = value.manifest.files.filter((file) => file.relativePath !== path); reseal(value);
      await expect(validate(value)).rejects.toThrow();
    }
  });
  it('rejects unknown check references and unreferenced check reports', async () => {
    const unknown = await fixture(); unknown.evidence.checks[0]!.evidencePath = 'reports/unknown.json';
    await expect(validate(unknown)).rejects.toThrow(/missing check file/);
    const extra = await fixture(); extra.manifest.files.push({ relativePath: 'reports/extra.json', role: 'check', sha256: 'a'.repeat(64), bytes: 1 }); extra.manifest.files.sort((a, b) => a.relativePath.localeCompare(b.relativePath)); reseal(extra);
    await expect(validate(extra)).rejects.toThrow(/unknown check report/);
  });
  it('rejects failed deterministic checks and unreferenced traces before review', async () => {
    const failed = await fixture(); failed.evidence.checks[0]!.passed = false;
    await expect(validate(failed)).rejects.toThrow(/deterministic checks/);
    const trace = await fixture(); trace.manifest.files.push({ relativePath: 'traces/extra.json', role: 'trace', sha256: 'a'.repeat(64), bytes: 1 }); trace.manifest.files.sort((a, b) => a.relativePath.localeCompare(b.relativePath)); reseal(trace);
    await expect(validate(trace)).rejects.toThrow(/unknown trace/);
  });
  it('rejects duplicate, missing and fourth artifacts before file reads', async () => {
    const duplicate = await fixture(); duplicate.manifest.files.push({ ...duplicate.manifest.files.find((file) => file.relativePath === 'outputs/1.png')!, relativePath: 'outputs/duplicate.png' }); duplicate.manifest.files.sort((a, b) => a.relativePath.localeCompare(b.relativePath)); reseal(duplicate);
    await expect(validate(duplicate)).rejects.toThrow(/three artifacts/);
    const missing = await fixture(); missing.manifest.files = missing.manifest.files.filter((file) => file.relativePath !== 'outputs/3.png'); reseal(missing);
    await expect(validate(missing)).rejects.toThrow();
  });
  it('rejects incomplete or forged vision indexing', async () => {
    const absent = await fixture(); absent.manifest.visionInputs = absent.manifest.visionInputs.filter((item) => item.id !== 'detail-2'); reseal(absent);
    await expect(validate(absent)).rejects.toThrow(/detail image/);
    const forged = await fixture(); forged.manifest.visionInputs.find((item) => item.id === 'output-2')!.sha256 = 'b'.repeat(64); reseal(forged);
    await expect(validate(forged)).rejects.toThrow(/output image/);
  });
  it('rejects Windows, traversal, Unicode and case-colliding paths', async () => {
    for (const bad of ['../outside', 'C:/outside', '//server/share', 'outputs\\..\\outside', 'con.txt', 'bad.', 'e\u0301.png']) {
      const value = await fixture(); value.manifest.files.find((file) => file.relativePath === 'outputs/1.png')!.relativePath = bad; value.manifest.files.sort((a, b) => a.relativePath.localeCompare(b.relativePath)); reseal(value);
      await expect(validate(value)).rejects.toThrow();
    }
    const collision = await fixture(); collision.manifest.files.push({ relativePath: 'Outputs/1.png', role: 'imageInput', sha256: 'a'.repeat(64), bytes: 1 }); collision.manifest.files.sort((a, b) => a.relativePath.localeCompare(b.relativePath)); reseal(collision);
    await expect(validate(collision)).rejects.toThrow(/collision/);
  });
  it('rejects symlinked files and parent directories', async () => {
    const file = await fixture(); const { unlink } = await import('node:fs/promises'); await unlink(join(file.root, 'outputs/1.png')); await symlink(join(file.root, 'outputs/2.png'), join(file.root, 'outputs/1.png'));
    await expect(validate(file)).rejects.toThrow(/symlink/);
    const directory = await fixture(); await rename(join(directory.root, 'references'), join(directory.root, 'moved-references')); await symlink(join(directory.root, 'moved-references'), join(directory.root, 'references'));
    await expect(validate(directory)).rejects.toThrow(/symlink/);
  });
  it('enforces trusted count, declared file and total byte limits before read', async () => {
    const count = await fixture(); await expect(validator(count, { ...limits, maxFiles: 1 }).validate({ bundleRoot: count.root, manifest: count.manifest, evidence: count.evidence, policy: count.policy })).rejects.toThrow(/read limits/);
    const individual = await fixture(); await expect(validator(individual, { ...limits, maxFileBytes: 1 }).validate({ bundleRoot: individual.root, manifest: individual.manifest, evidence: individual.evidence, policy: individual.policy })).rejects.toThrow(/read limits/);
    const total = await fixture(); await expect(validator(total, { ...limits, maxTotalBytes: 1 }).validate({ bundleRoot: total.root, manifest: total.manifest, evidence: total.evidence, policy: total.policy })).rejects.toThrow(/read limits/);
  });
  it('rejects a file whose actual stat size differs from the sealed declaration', async () => {
    const value = await fixture(); await writeFile(join(value.root, 'outputs/1.png'), 'longer than the sealed file');
    await expect(validate(value)).rejects.toThrow(/file size before read/);
  });
});

describe('trusted manual attestation', () => {
  const receipt = (value: Awaited<ReturnType<typeof fixture>>) => {
    const withoutAttestation = { ...value.manifest, files: value.manifest.files.filter((file) => file.role !== 'humanAttestation') };
    const contact = value.manifest.files.find((file) => file.relativePath === 'contact.png')!;
    const attestation = value.manifest.files.find((file) => file.role === 'humanAttestation')!;
    return { request: { requestId: 'issued-by-core', jobId: value.job.jobId, assetId: 'asset-1', attempt: 1 as const, preAttestationContentSha256: bundleDigest(withoutAttestation), profileSha256: value.job.profile.profileSha256, sourceSha256: value.evidence.sourceSha256, toolSchemaSha256: value.evidence.toolSchemaSha256, reviewPolicySha256: value.policy.policySha256, artifacts: value.evidence.artifacts, contactSheet: { relativePath: contact.relativePath, sha256: contact.sha256 } }, decision: 'approve' as const, operatorIdentity: 'trusted-os-user', consumed: true as const, consumedAt: '2026-09-30T12:00:00.000Z', expiresAt: '2026-09-30T13:00:00.000Z', attestationRelativePath: attestation.relativePath, attestationSha256: attestation.sha256 };
  };
  const now = Date.parse('2026-09-30T12:30:00.000Z');
  it('requires the current consumed A-owned approval and frozen content', async () => {
    const value = await fixture('humanPerAsset'); const snapshot = await validate(value);
    expect((await validateVisualAttestation(snapshot, async () => receipt(value), now)).operatorIdentity).toBe('trusted-os-user');
  });
  it('blocks absent, rejected, unconsumed, unidentified and expired records', async () => {
    const value = await fixture('humanPerAsset'); const snapshot = await validate(value); const valid = receipt(value);
    for (const record of [null, { ...valid, decision: 'reject' as const }, { ...valid, consumed: false as const }, { ...valid, operatorIdentity: '' }]) await expect(validateVisualAttestation(snapshot, async () => record as any, now)).rejects.toThrow();
    await expect(validateVisualAttestation(snapshot, async () => valid, Date.parse('2026-09-30T14:00:00.000Z'))).rejects.toThrow(/EXPIRED/);
  });
  it('blocks other subjects, provenance, content, contact sheet and attestation file', async () => {
    const value = await fixture('humanPerAsset'); const snapshot = await validate(value); const valid = receipt(value);
    for (const changed of [
      { ...valid, request: { ...valid.request, assetId: 'other' } },
      { ...valid, request: { ...valid.request, attempt: 2 as const } },
      { ...valid, request: { ...valid.request, reviewPolicySha256: 'b'.repeat(64) } },
      { ...valid, request: { ...valid.request, preAttestationContentSha256: 'b'.repeat(64) } },
      { ...valid, request: { ...valid.request, contactSheet: { ...valid.request.contactSheet, sha256: 'b'.repeat(64) } } },
      { ...valid, attestationSha256: 'b'.repeat(64) },
    ]) await expect(validateVisualAttestation(snapshot, async () => changed as any, now)).rejects.toThrow();
  });
});
