import { sha256Json, validateConfigurationProposal, EvidenceBundleManifestSchema, VisualReviewRequestSchema } from '@ne-psd/contracts';
import type { ConfigurationProposal, InspectionReport, TemplateProfile, EvidenceBundleManifest, VisualReviewRequest } from '@ne-psd/contracts';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

export type QualificationOutcome = { status: 'qualified'; profile: TemplateProfile } | { status: 'blocked'; reason: string };
const block = (reason: string): QualificationOutcome => ({ status: 'blocked', reason });

export function qualifyInspection(inspection: InspectionReport, proposal: ConfigurationProposal, workingTemplatePath: string, evidenceDirectory: string): QualificationOutcome {
  if (inspection.evidenceStatus !== 'liveObserved' || inspection.capabilities === null) return block('qualification requires live inspection and capabilities');
  if (!/^\//.test(workingTemplatePath) || !/^\//.test(evidenceDirectory)) return block('qualification paths must be absolute');
  if (/^(.)\1+$/.test(inspection.template.sha256)) return block('template bytes changed or are not verified');
  const duplicateSelectors = new Set<string>();
  for (const candidate of inspection.candidates) { const key = JSON.stringify(candidate.selector); if (duplicateSelectors.has(key)) return block('structurally ambiguous selector'); duplicateSelectors.add(key); }
  const checked = validateConfigurationProposal(proposal, inspection); if (!checked.success) return block(checked.error.message);
  if (!inspection.capabilities.supportedFitModes.includes(proposal.fitMode)) return block(`fit mode ${proposal.fitMode} is unsupported: Этот способ размещения не проверен для выбранного шаблона`);
  if (inspection.documents.some((document) => document.sourceKind === 'linked') && !inspection.evidencePaths.some((path) => path.includes('linked-isolation'))) return block('linked dependency isolation evidence is missing');
  const byId = new Map(inspection.candidates.map((candidate) => [candidate.candidateId, candidate]));
  const target = proposal.targets[0]!; const targetCandidate = byId.get(target.targetCandidateId); const reference = byId.get(target.referenceCandidateId); if (!targetCandidate || !reference) return block('target or reference selector is missing');
  const variants = proposal.variants.map((variant) => byId.get(variant.groupCandidateId)); if (variants.some((variant) => !variant)) return block('all three variant selectors are required');
  const output = proposal.output; if (!output) return block('output policy is required');
  const profileBase = { schemaVersion: 1 as const, profileId: `profile-${inspection.inspectionId}`, template: inspection.template, qualificationId: `qualification-${inspection.inspectionId}`, backendId: inspection.capabilities.backendId, toolSchemaSha256: inspection.capabilities.toolSchemaSha256, fitMode: proposal.fitMode, output, variants: proposal.variants.map((variant, index) => ({ id: variant.id, group: variants[index]!.selector })), targets: [{ target: targetCandidate.selector, reference: reference.selector, input: target.inputCandidateId === null ? null : (byId.get(target.inputCandidateId)?.selector ?? null) }] };
  const profile = { ...profileBase, profileSha256: sha256Json(profileBase) } as TemplateProfile;
  return { status: 'qualified', profile };
}

export type VerifiedReviewImages = {
  requestId: string; jobId: string; assetId: string; attempt: 1 | 2;
  variants: Array<{ variantId: '1' | '2' | '3'; sha256: string; dataUrl: string }>;
  contactSheet: { sha256: string; dataUrl: string };
};

const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
async function imageBytes(root: string, relativePath: string, expectedSha256: string, expectedBytes?: number): Promise<{ dataUrl: string; canonicalPath: string }> {
  if (isAbsolute(relativePath) || relativePath.includes('\\') || relativePath.includes('\0') ||
      relativePath.split('/').some((segment) => !segment || segment === '.' || segment === '..')) throw new Error('review image path is invalid');
  const canonicalRoot = await realpath(root);
  let cursor = canonicalRoot;
  for (const segment of relativePath.split('/')) {
    cursor = join(cursor, segment);
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error('review image symlink is forbidden');
  }
  const canonicalFile = await realpath(cursor);
  const inside = relative(canonicalRoot, canonicalFile);
  if (!inside || inside.startsWith(`..${sep}`) || inside === '..' || isAbsolute(inside)) throw new Error('review image escapes bundle root');
  const file = await open(canonicalFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  let base64: string;
  let png: boolean;
  let jpeg: boolean;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 1 || info.size > MAX_IMAGE_BYTES || expectedBytes !== undefined && info.size !== expectedBytes) throw new Error('review image size mismatch');
    const hash = createHash('sha256');
    const chunks: string[] = [];
    const buffer = Buffer.alloc(64 * 1024);
    let carry = Buffer.alloc(0);
    let first = Buffer.alloc(0);
    let last = Buffer.alloc(0);
    let total = 0;
    while (total < info.size) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, info.size - total), total);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      if (first.length < 8) first = Buffer.concat([first, chunk.subarray(0, 8 - first.length)]);
      last = Buffer.concat([last, chunk]).subarray(Math.max(0, last.length + bytesRead - 2));
      const encoded = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const complete = encoded.length - encoded.length % 3;
      if (complete) chunks.push(encoded.subarray(0, complete).toString('base64'));
      carry = Buffer.from(encoded.subarray(complete));
      total += bytesRead;
    }
    if (total !== info.size || (await file.read(buffer, 0, 1, total)).bytesRead !== 0 || hash.digest('hex') !== expectedSha256) throw new Error('review image digest mismatch');
    if (carry.length) chunks.push(carry.toString('base64'));
    png = first.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    jpeg = first[0] === 0xff && first[1] === 0xd8 && last[0] === 0xff && last[1] === 0xd9;
    base64 = chunks.join('');
  } finally {
    await file.close();
  }
  if (!png && !jpeg) throw new Error('review image must be PNG or JPEG bytes');
  return { dataUrl: `data:image/${png ? 'png' : 'jpeg'};base64,${base64}`, canonicalPath: canonicalFile };
}

export async function readReviewImages(root: string, request: VisualReviewRequest, manifest: EvidenceBundleManifest): Promise<VerifiedReviewImages> {
  const checkedRequest = VisualReviewRequestSchema.parse(request);
  const checkedManifest = EvidenceBundleManifestSchema.parse(manifest);
  if (checkedRequest.jobId !== checkedManifest.jobId || checkedRequest.assetId !== checkedManifest.assetId || checkedRequest.attempt !== checkedManifest.attempt) throw new Error('review request and manifest do not match');
  const variants: VerifiedReviewImages['variants'] = [];
  for (const artifact of checkedRequest.artifacts) {
    const file = checkedManifest.files.find((item) => item.relativePath === artifact.path && item.role === 'artifact' && item.sha256 === artifact.sha256 && item.bytes === artifact.bytes);
    const vision = checkedManifest.visionInputs.find((item) => item.role === 'output' && item.variantId === artifact.variantId && item.relativePath === artifact.path && item.sha256 === artifact.sha256);
    if (!file || !vision) throw new Error('review output is not bound to manifest');
    const { dataUrl } = await imageBytes(root, artifact.path, artifact.sha256, artifact.bytes);
    if (!dataUrl.startsWith(`data:image/${artifact.format};`)) throw new Error('review output format mismatch');
    variants.push({ variantId: artifact.variantId, sha256: artifact.sha256, dataUrl });
  }
  const sheet = checkedManifest.files.find((item) => item.relativePath === checkedRequest.contactSheet.relativePath && item.role === 'imageInput' && item.sha256 === checkedRequest.contactSheet.sha256);
  if (!sheet) throw new Error('contact sheet is not bound to manifest');
  return { requestId: checkedRequest.requestId, jobId: checkedRequest.jobId, assetId: checkedRequest.assetId, attempt: checkedRequest.attempt,
    variants, contactSheet: { sha256: sheet.sha256, dataUrl: (await imageBytes(root, sheet.relativePath, sheet.sha256, sheet.bytes)).dataUrl } };
}

export type CommittedOutputRecord = { jobId: string; relativePath: string; sha256: string; bytes: number; state: 'complete' };
export async function resolveCommittedOutput(root: string, jobId: string, record: CommittedOutputRecord): Promise<string> {
  if (record.jobId !== jobId || record.state !== 'complete' ||
      record.relativePath.split('/').some((segment) => /staging/i.test(segment))) throw new Error('output is not a committed result');
  return (await imageBytes(root, record.relativePath, record.sha256, record.bytes)).canonicalPath;
}
