import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bundleDigest, sha256Bytes, sha256Json, type EvidenceBundleManifest, type JobSpec, type RenderEvidence, type ReviewPolicy } from '@ne-psd/contracts';
import type { TrustedAttemptState } from '../../../packages/intelligence/src/review/evidence-validator.js';

const sha = 'a'.repeat(64);
const bytes = (text: string) => new TextEncoder().encode(text);
const selector = (name: string) => ({ documentRoute: [], layerPath: [{ name, kind: 'smartObject' as const, fingerprint: name }] });

export async function createReviewFixture(gate: 'qualifiedVisionReviewer' | 'humanPerAsset' = 'qualifiedVisionReviewer') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ne-psd-review-')));
  const profileBase = { schemaVersion: 1 as const, profileId: 'template', template: { rootId: 'root', relativePath: 'template.psd', sha256: sha }, qualificationId: 'qualified-template', backendId: 'alisaitteke' as const, toolSchemaSha256: sha, targets: [{ target: selector('target'), reference: selector('reference'), input: null }], fitMode: 'contain' as const, output: { format: 'png' as const, quality: 100, colorSpace: 'sRGB' as const, width: 10, height: 10 }, variants: (['1', '2', '3'] as const).map((id) => ({ id, group: selector(`variant-${id}`) })) as any };
  const profile = { ...profileBase, profileSha256: sha256Json(profileBase) };
  const sourceBytes = bytes('source design'); const sourceSha256 = sha256Bytes(sourceBytes);
  const policyBase = { schemaVersion: 1 as const, policyId: 'review-policy', promptSha256: sha, requirements: [{ id: 'IMAGE.COMPLETE', description: 'complete', mandatory: true, evaluator: 'model' as const }], visualGate: gate };
  const policy: ReviewPolicy = { ...policyBase, policySha256: sha256Json(policyBase) };
  const job: JobSpec = { schemaVersion: 1, jobId: 'job-1', profile, assets: [{ assetId: 'asset-1', source: { rootId: 'input', relativePath: 'source.png', sha256: sourceSha256 }, sourceBytes: sourceBytes.length }], outputRootId: 'output', modelProfileId: 'planner', reviewerModelProfileId: 'reviewer', reviewPolicySha256: policy.policySha256, trigger: 'interactive', maxAttempts: 2 };
  const artifacts = (['1', '2', '3'] as const).map((variantId) => { const image = bytes(`output image ${variantId}`); return { variantId, path: `outputs/${variantId}.png`, sha256: sha256Bytes(image), bytes: image.length, colorSpace: 'sRGB' as const, width: 10, height: 10, format: 'png' as const }; }) as RenderEvidence['artifacts'];
  const evidence: RenderEvidence = { schemaVersion: 1, jobId: job.jobId, assetId: 'asset-1', attempt: 1, profileSha256: profile.profileSha256, sourceSha256, toolSchemaSha256: profile.toolSchemaSha256, geometry: [], visibility: [], artifacts, checks: [{ id: 'QA', passed: true, evidencePath: 'reports/qa.json' }], documentTracePath: 'traces/document.json', toolTracePath: 'traces/tool.json' };
  const contents = new Map<string, Uint8Array>([['render-evidence.json', bytes(JSON.stringify(evidence))], ['source.png', sourceBytes], ['reports/qa.json', bytes('{"passed":true}')], ['traces/document.json', bytes('{}')], ['traces/tool.json', bytes('{}')]]);
  const files: EvidenceBundleManifest['files'] = [];
  const put = (path: string, content: Uint8Array, role: EvidenceBundleManifest['files'][number]['role']) => { contents.set(path, content); files.push({ relativePath: path, sha256: sha256Bytes(content), bytes: content.length, role }); };
  for (const artifact of artifacts) put(artifact.path, bytes(`output image ${artifact.variantId}`), 'artifact');
  for (const [path, role] of [['render-evidence.json', 'renderEvidence'], ['source.png', 'imageInput'], ['reports/qa.json', 'check'], ['traces/document.json', 'trace'], ['traces/tool.json', 'trace']] as const) put(path, contents.get(path)!, role);
  const visionInputs: EvidenceBundleManifest['visionInputs'] = [{ id: 'source', role: 'source', relativePath: 'source.png', sha256: sourceSha256, width: 10, height: 10, variantId: null, derivedFromSha256: sourceSha256, crop: null }];
  for (const artifact of artifacts) {
    const referencePath = `references/${artifact.variantId}.png`; const referenceBytes = bytes(`reference image ${artifact.variantId}`); put(referencePath, referenceBytes, 'imageInput');
    visionInputs.push({ id: `reference-${artifact.variantId}`, role: 'reference', relativePath: referencePath, sha256: sha256Bytes(referenceBytes), width: 10, height: 10, variantId: artifact.variantId, derivedFromSha256: sha256Bytes(referenceBytes), crop: null });
    visionInputs.push({ id: `output-${artifact.variantId}`, role: 'output', relativePath: artifact.path, sha256: artifact.sha256, width: 10, height: 10, variantId: artifact.variantId, derivedFromSha256: artifact.sha256, crop: null });
    const detailPath = `details/${artifact.variantId}.png`; const detailBytes = bytes(`detail image ${artifact.variantId}`); put(detailPath, detailBytes, 'imageInput');
    visionInputs.push({ id: `detail-${artifact.variantId}`, role: 'detail', relativePath: detailPath, sha256: sha256Bytes(detailBytes), width: 4, height: 4, variantId: artifact.variantId, derivedFromSha256: artifact.sha256, crop: { left: 1, top: 1, right: 5, bottom: 5 } });
  }
  if (gate === 'humanPerAsset') { put('contact.png', bytes('contact sheet'), 'imageInput'); put('attestation.json', bytes('{"trustedByCore":true}'), 'humanAttestation'); }
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const manifest: EvidenceBundleManifest = { schemaVersion: 1, jobId: job.jobId, assetId: 'asset-1', attempt: 1, files, visionInputs };
  for (const [path, content] of contents) { const target = join(root, path); await mkdir(join(target, '..'), { recursive: true }); await writeFile(target, content); }
  const state: TrustedAttemptState = { job, currentAttempt: 1, sealed: true, sealedEvidenceSha256: bundleDigest(manifest) };
  return { root, job, policy, evidence, manifest, state, contents, close: () => rm(root, { recursive: true, force: true }) };
}
