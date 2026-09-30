import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it, onTestFinished } from 'vitest';
import { bundleDigest, type JobSpec, type RenderEvidence, type RenderRequest, type RenderRequestV2, type RenderEvidenceV2 } from '@ne-psd/contracts';
import { buildEvidenceBundle, verifyEvidenceBundle } from '../../packages/core/src/evidence-bundle.js';
import { readFixture } from '../fixtures/read-fixture.js';

const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ne-psd-evidence-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  for (const directory of ['exports', 'references', 'details', 'trace']) await mkdir(join(root, directory));
  const job = structuredClone(readFixture<JobSpec>('job.interactive.json'));
  const image = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#114488' } }).png().toBuffer();
  const detail = await sharp(image).extract({ left: 1, top: 1, width: 4, height: 4 }).png().toBuffer();
  await writeFile(join(root, 'source.png'), image);
  const asset = { ...job.assets[0]!, source: { ...job.assets[0]!.source, sha256: hash(image) }, sourceBytes: image.length };
  const request: RenderRequest = { schemaVersion: 1, jobId: job.jobId, asset, profile: job.profile, attempt: 1, stagingDirectory: root };
  const artifacts = [] as RenderEvidence['artifacts'][number][];
  const references = [] as Array<{ variantId: '1' | '2' | '3'; path: string; sha256: string; qualificationId: string }>;
  const details = [] as Array<{ variantId: '1' | '2' | '3'; path: string; derivedFromPath: string; crop: { left: number; top: number; right: number; bottom: number } }>;
  for (const variantId of ['1', '2', '3'] as const) {
    const outputPath = `exports/${variantId}.png`;
    const referencePath = `references/${variantId}.png`;
    const detailPath = `details/${variantId}.png`;
    await writeFile(join(root, outputPath), image);
    await writeFile(join(root, referencePath), image);
    await writeFile(join(root, detailPath), detail);
    artifacts.push({ variantId, path: outputPath, sha256: hash(image), bytes: image.length, colorSpace: 'sRGB', width: 8, height: 8, format: 'png' });
    references.push({ variantId, path: referencePath, sha256: hash(image), qualificationId: job.profile.qualificationId });
    details.push({ variantId, path: detailPath, derivedFromPath: outputPath, crop: { left: 1, top: 1, right: 5, bottom: 5 } });
  }
  for (const path of ['trace/document.json', 'trace/tool.json', 'trace/check.json']) await writeFile(join(root, path), JSON.stringify({ path }));
  const evidence: RenderEvidence = {
    schemaVersion: 1, jobId: job.jobId, assetId: asset.assetId, attempt: 1,
    profileSha256: job.profile.profileSha256, sourceSha256: asset.source.sha256, toolSchemaSha256: job.profile.toolSchemaSha256,
    geometry: [], visibility: [], artifacts: artifacts as RenderEvidence['artifacts'],
    checks: [{ id: 'check', passed: true, evidencePath: 'trace/check.json' }],
    documentTracePath: 'trace/document.json', toolTracePath: 'trace/tool.json',
  };
  await writeFile(join(root, 'render-evidence.json'), JSON.stringify(evidence));
  return { root, request, evidence, references, details, image, input: { root, request, evidence, sourcePath: 'source.png', references, details } };
}

describe('immutable evidence bundle', () => {
  it('binds actual source, qualified references, three outputs, details, traces and checks', async () => {
    const f = await fixture();
    const bundle = await buildEvidenceBundle(f.input);
    expect(bundle.manifest.files.map((file) => file.relativePath)).toEqual([...bundle.manifest.files.map((file) => file.relativePath)].sort());
    expect(bundle.manifest.visionInputs.filter((input) => input.role === 'output')).toHaveLength(3);
    expect(bundle.manifest.visionInputs.filter((input) => input.role === 'reference')).toHaveLength(3);
    expect(bundle.manifest.visionInputs.filter((input) => input.role === 'detail')).toHaveLength(3);
    expect(bundle.evidenceSha256).toBe(bundleDigest(bundle.manifest));
    await verifyEvidenceBundle(f.root, bundle.manifest);
  });

  it('detects changed bytes after sealing', async () => {
    const f = await fixture();
    const bundle = await buildEvidenceBundle(f.input);
    await writeFile(join(f.root, 'trace/tool.json'), '{}');
    await expect(verifyEvidenceBundle(f.root, bundle.manifest)).rejects.toThrow(/changed/i);
  });

  it('rejects missing or forged reference provenance and detail derivation', async () => {
    const f = await fixture();
    f.references[0]!.qualificationId = 'unqualified';
    await expect(buildEvidenceBundle(f.input)).rejects.toThrow(/qualification/i);
    f.references[0]!.qualificationId = f.request.profile.qualificationId;
    f.references[0]!.sha256 = 'a'.repeat(64);
    await expect(buildEvidenceBundle(f.input)).rejects.toThrow(/changed|digest/i);
    f.references[0]!.sha256 = hash(f.image);
    f.details[0]!.crop.left = 2;
    await expect(buildEvidenceBundle(f.input)).rejects.toThrow(/crop|deriv/i);
  });

  it('rejects a symlink escape and missing output', async () => {
    const f = await fixture();
    await rm(join(f.root, 'references/1.png'));
    await symlink(join(f.root, 'source.png'), join(f.root, 'references/1.png'));
    await expect(buildEvidenceBundle(f.input)).rejects.toThrow(/symlink/i);
    await rm(join(f.root, 'exports/3.png'));
    await expect(buildEvidenceBundle(f.input)).rejects.toThrow();
  });

  it('closes V2 proof references including release owner and journal snapshots', async () => {
    const f = await fixture();
    for (const directory of ['scratch', 'checks', 'template']) await mkdir(join(f.root, directory));
    const ownedSource = 'scratch/source.png';
    await writeFile(join(f.root, ownedSource), f.image);
    const write = async (path: string, value: Buffer | string) => { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value); await writeFile(join(f.root, path), bytes); return { relativePath: path, sha256: hash(bytes) }; };
    const closure = await write('checks/linked-closure.json', '{}');
    const owner = await write('checks/owner.json', '{"owner":"job"}');
    const journal = await write('checks/journal.json', '{"released":true}');
    await writeFile(join(f.root, 'template/working.psd'), Buffer.from('working copy'));
    const operationId = 'operation-one';
    const identity = { schemaVersion: 2 as const, jobId: f.request.jobId, assetId: f.request.asset.assetId, attempt: f.request.attempt, operationId };
    const sourceCopy = { original: f.request.asset.source, ownedRelativePath: ownedSource, bytes: f.image.length,
      originalBeforeSha256: hash(f.image), originalAfterSha256: hash(f.image), copyBeforeSha256: hash(f.image), copyAfterSha256: hash(f.image) };
    const ownedProof = { ...identity, sourceRootIdentity: 'a'.repeat(64), openedSourceRelativePath: ownedSource, source: sourceCopy,
      dependencies: [], observedLinks: [], closureProof: closure };
    const ownedRef = await write('checks/owned.json', JSON.stringify(ownedProof));
    const templateOriginal = f.request.profile.template;
    const templateProof = { ...identity, template: templateOriginal, workingTemplateRelativePath: 'template/working.psd',
      closureEntries: [{ original: templateOriginal, ownedRelativePath: 'template/working.psd', bytes: 12,
        originalBeforeSha256: templateOriginal.sha256, originalAfterSha256: templateOriginal.sha256,
        copyBeforeSha256: templateOriginal.sha256, copyAfterSha256: templateOriginal.sha256,
        identity: 'template-root', sourceKind: 'template' }], observedLinks: [],
      documentTrace: { relativePath: f.evidence.documentTracePath, sha256: hash(Buffer.from(JSON.stringify({ path: f.evidence.documentTracePath }))) } };
    const templateRef = await write('checks/template.json', JSON.stringify(templateProof));
    const releaseProof = { ...identity, released: true, ownerIdentitySha256: owner.sha256, journalSha256: journal.sha256,
      ownerSnapshot: owner, journalSnapshot: journal };
    const releaseRef = await write('checks/release.json', JSON.stringify(releaseProof));
    const request: RenderRequestV2 = { ...f.request, schemaVersion: 2, operationId,
      ownedInput: { scratchDirectory: 'scratch', source: { relativePath: ownedSource, sha256: hash(f.image), bytes: f.image.length },
        dependencies: [], closureProof: closure, sourceRootIdentity: 'a'.repeat(64) } };
    const evidence: RenderEvidenceV2 = { ...f.evidence, schemaVersion: 2, operationId,
      ownedInputProof: ownedRef, templateClosureProof: templateRef, released: true, releaseProof: releaseRef };
    await writeFile(join(f.root, 'render-evidence.json'), JSON.stringify(evidence));
    const bundle = await buildEvidenceBundle({ ...f.input, request, evidence, sourcePath: ownedSource });
    for (const path of ['checks/owned.json', 'checks/template.json', 'checks/release.json', 'checks/linked-closure.json', 'checks/owner.json', 'checks/journal.json', 'template/working.psd']) {
      expect(bundle.manifest.files.some((file) => file.relativePath === path)).toBe(true);
    }
    await writeFile(join(f.root, 'checks/owner.json'), '{}');
    await expect(verifyEvidenceBundle(f.root, bundle.manifest)).rejects.toThrow(/changed/i);
  });
});
