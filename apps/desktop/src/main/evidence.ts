import { sha256Json, validateConfigurationProposal, EvidenceBundleManifestSchema, VisualReviewRequestSchema } from '@ne-psd/contracts';
import type { ConfigurationProposal, InspectionReport, TemplateProfile, EvidenceBundleManifest, VisualReviewRequest } from '@ne-psd/contracts';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
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
function imageBytes(root: string, relativePath: string, expectedSha256: string, expectedBytes?: number): string {
  if (isAbsolute(relativePath) || relativePath.includes('\\') || relativePath.includes('\0') ||
      relativePath.split('/').some((segment) => !segment || segment === '.' || segment === '..')) throw new Error('review image path is invalid');
  const canonicalRoot = realpathSync(root);
  let cursor = canonicalRoot;
  for (const segment of relativePath.split('/')) {
    cursor = join(cursor, segment);
    if (lstatSync(cursor).isSymbolicLink()) throw new Error('review image symlink is forbidden');
  }
  const canonicalFile = realpathSync(cursor);
  const inside = relative(canonicalRoot, canonicalFile);
  if (!inside || inside.startsWith(`..${sep}`) || inside === '..' || isAbsolute(inside)) throw new Error('review image escapes bundle root');
  const info = statSync(canonicalFile);
  if (!info.isFile() || info.size < 1 || info.size > MAX_IMAGE_BYTES || expectedBytes !== undefined && info.size !== expectedBytes) throw new Error('review image size mismatch');
  const bytes = readFileSync(canonicalFile);
  if (bytes.length !== info.size || createHash('sha256').update(bytes).digest('hex') !== expectedSha256) throw new Error('review image digest mismatch');
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
  if (!png && !jpeg) throw new Error('review image must be PNG or JPEG bytes');
  return `data:image/${png ? 'png' : 'jpeg'};base64,${bytes.toString('base64')}`;
}

export function readReviewImages(root: string, request: VisualReviewRequest, manifest: EvidenceBundleManifest): VerifiedReviewImages {
  const checkedRequest = VisualReviewRequestSchema.parse(request);
  const checkedManifest = EvidenceBundleManifestSchema.parse(manifest);
  if (checkedRequest.jobId !== checkedManifest.jobId || checkedRequest.assetId !== checkedManifest.assetId || checkedRequest.attempt !== checkedManifest.attempt) throw new Error('review request and manifest do not match');
  const variants = checkedRequest.artifacts.map((artifact) => {
    const file = checkedManifest.files.find((item) => item.relativePath === artifact.path && item.role === 'artifact' && item.sha256 === artifact.sha256 && item.bytes === artifact.bytes);
    const vision = checkedManifest.visionInputs.find((item) => item.role === 'output' && item.variantId === artifact.variantId && item.relativePath === artifact.path && item.sha256 === artifact.sha256);
    if (!file || !vision) throw new Error('review output is not bound to manifest');
    const dataUrl = imageBytes(root, artifact.path, artifact.sha256, artifact.bytes);
    if (!dataUrl.startsWith(`data:image/${artifact.format};`)) throw new Error('review output format mismatch');
    return { variantId: artifact.variantId, sha256: artifact.sha256, dataUrl };
  });
  const sheet = checkedManifest.files.find((item) => item.relativePath === checkedRequest.contactSheet.relativePath && item.role === 'imageInput' && item.sha256 === checkedRequest.contactSheet.sha256);
  if (!sheet) throw new Error('contact sheet is not bound to manifest');
  return { requestId: checkedRequest.requestId, jobId: checkedRequest.jobId, assetId: checkedRequest.assetId, attempt: checkedRequest.attempt,
    variants, contactSheet: { sha256: sheet.sha256, dataUrl: imageBytes(root, sheet.relativePath, sheet.sha256, sheet.bytes) } };
}

export type CommittedOutputRecord = { jobId: string; relativePath: string; sha256: string; bytes: number; state: 'complete' };
export function resolveCommittedOutput(root: string, jobId: string, record: CommittedOutputRecord): string {
  if (record.jobId !== jobId || record.state !== 'complete' ||
      record.relativePath.split('/').some((segment) => /staging/i.test(segment))) throw new Error('output is not a committed result');
  imageBytes(root, record.relativePath, record.sha256, record.bytes);
  return join(realpathSync(root), record.relativePath);
}
