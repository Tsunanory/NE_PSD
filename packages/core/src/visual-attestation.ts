import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import sharp from 'sharp';
import {
  bundleDigest, canonicalize, EvidenceBundleManifestSchema, HumanVisualAttestationV1Schema, JobSpecSchema,
  ReviewEvidenceSchema, ReviewPolicySchema, sha256Json, VisualReviewRequestSchema,
  type EvidenceBundleManifest, type HumanVisualAttestationV1, type JobSpec, type ReviewEvidence,
  type ReviewPolicy, type VariantId, type VisualReviewRequest,
} from '@ne-psd/contracts';
import { verifyEvidenceBundle } from './evidence-bundle.js';

const ids = ['1', '2', '3'] as const;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const fail = (reason: string): never => { throw new Error(`VISUAL_ATTESTATION_INVALID: ${reason}`); };
export type TrustedVisualReviewState = {
  root: string;
  job: JobSpec;
  policy: ReviewPolicy;
  evidence: ReviewEvidence;
  manifest: EvidenceBundleManifest;
  currentAttempt: 1 | 2;
  currentRequestId: string | null;
  qualifiedReferences: Readonly<Record<VariantId, string>>;
  plannerProfileSha256: string;
  reviewerProfileSha256: string;
};
export type ContactPanel = { role: 'output' | 'reference' | 'detail'; variantId: VariantId; relativePath: string; left: number; top: number; width: number; height: number };
export type PreparedVisualReview = { request: VisualReviewRequest; contentManifest: EvidenceBundleManifest; layout: ContactPanel[] };

async function readBoundImage(root: string, path: string, expectedSha256: string): Promise<Buffer> {
  const physicalRoot = await realpath(root);
  const candidate = resolve(physicalRoot, path);
  const fromRoot = relative(physicalRoot, candidate);
  if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) fail('image path escapes staging');
  let current = candidate;
  while (current !== physicalRoot) {
    const info = await lstat(current).catch(() => fail('image path missing'));
    if (info.isSymbolicLink()) fail('image path contains symlink');
    current = dirname(current);
  }
  if ((await realpath(candidate)) !== candidate) fail('image path changed');
  const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size <= 0) fail('image file empty');
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length !== before.size || after.size !== before.size || before.dev !== after.dev || before.ino !== after.ino
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || hash(bytes) !== expectedSha256
      || (await realpath(candidate)) !== candidate) fail('image changed during contact sheet read');
    return bytes;
  } finally { await handle.close(); }
}

function assertState(state: TrustedVisualReviewState): void {
  const job = JobSpecSchema.parse(state.job);
  const evidence = ReviewEvidenceSchema.parse(state.evidence);
  const policy = ReviewPolicySchema.parse(state.policy);
  EvidenceBundleManifestSchema.parse(state.manifest);
  if (job.trigger !== 'interactive' || policy.visualGate !== 'humanPerAsset') fail('manual review is interactive only');
  if (job.reviewPolicySha256 !== policy.policySha256 || sha256Json(policy, { excludeKeys: ['policySha256'] }) !== policy.policySha256
    || job.jobId !== evidence.jobId || state.manifest.jobId !== job.jobId
    || state.manifest.assetId !== evidence.assetId || state.manifest.attempt !== evidence.attempt || state.currentAttempt !== evidence.attempt
    || evidence.profileSha256 !== job.profile.profileSha256 || evidence.toolSchemaSha256 !== job.profile.toolSchemaSha256
    || !job.assets.some((asset) => asset.assetId === evidence.assetId && asset.source.sha256 === evidence.sourceSha256)) fail('current attempt/source/profile/policy binding mismatch');
  if (!/^[a-f0-9]{64}$/.test(state.plannerProfileSha256) || !/^[a-f0-9]{64}$/.test(state.reviewerProfileSha256)) fail('selected model profile digest missing');
  if (evidence.artifacts.length !== 3 || evidence.artifacts.some((artifact, index) => artifact.variantId !== ids[index])) fail('exactly three current outputs required');
}

function selectPanels(state: TrustedVisualReviewState): Array<{ role: ContactPanel['role']; variantId: VariantId; relativePath: string; sha256: string; width: number; height: number }> {
  const visions = state.manifest.visionInputs;
  const selected = [] as ReturnType<typeof selectPanels>;
  for (const role of ['output', 'reference', 'detail'] as const) {
    for (const id of ids) {
      const matches = visions.filter((input) => input.role === role && input.variantId === id);
      if (matches.length !== 1) fail(`${role} image missing or ambiguous for variant ${id}`);
      const match = matches[0]!;
      const file = state.manifest.files.find((item) => item.relativePath === match.relativePath);
      if (!file || file.sha256 !== match.sha256 || file.role !== (role === 'output' ? 'artifact' : 'imageInput')) fail(`${role} image not sealed`);
      if (role === 'reference' && state.qualifiedReferences[id] !== match.sha256) fail(`reference ${id} is not qualified`);
      if (role === 'output' && state.evidence.artifacts.find((item) => item.variantId === id)?.sha256 !== match.sha256) fail(`output ${id} differs from render`);
      if (role === 'detail' && (!match.crop || match.derivedFromSha256 !== state.evidence.artifacts.find((item) => item.variantId === id)?.sha256)) fail(`detail ${id} derivation missing`);
      selected.push({ role, variantId: id, relativePath: match.relativePath, sha256: match.sha256, width: match.width, height: match.height });
    }
  }
  return selected;
}

export async function prepareVisualReviewRequest(state: TrustedVisualReviewState): Promise<PreparedVisualReview> {
  assertState(state);
  if (state.currentRequestId !== null) fail('one-shot request already exists');
  if (state.manifest.files.some((file) => file.role === 'humanAttestation' || file.relativePath === 'review/contact-sheet.png')) fail('pre-attestation manifest already finalized');
  await verifyEvidenceBundle(state.root, state.manifest);
  const selections = selectPanels(state);
  const gutter = 16;
  const layout: ContactPanel[] = [];
  const rows = [selections.slice(0, 3), selections.slice(3, 6), selections.slice(6, 9)];
  const width = Math.max(...rows.map((row) => row.reduce((sum, item) => sum + item.width, 2 * gutter)));
  const height = rows.reduce((sum, row) => sum + Math.max(...row.map((item) => item.height)), 2 * gutter);
  if (!Number.isSafeInteger(width * height) || width * height > 100_000_000) fail('contact sheet too large to preserve full pixels');
  let top = 0;
  for (const row of rows) {
    let left = 0;
    for (const item of row) { layout.push({ role: item.role, variantId: item.variantId, relativePath: item.relativePath, left, top, width: item.width, height: item.height }); left += item.width + gutter; }
    top += Math.max(...row.map((item) => item.height)) + gutter;
  }
  const composites = await Promise.all(layout.map(async (panel) => {
    const selected = selections.find((item) => item.relativePath === panel.relativePath && item.role === panel.role && item.variantId === panel.variantId)!;
    const bytes = await readBoundImage(state.root, panel.relativePath, selected.sha256);
    const metadata = await sharp(bytes, { failOn: 'error' }).metadata();
    if (metadata.width !== panel.width || metadata.height !== panel.height) fail(`image dimensions changed: ${panel.relativePath}`);
    return { input: bytes, left: panel.left, top: panel.top };
  }));
  const sheet = await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(composites).png().toBuffer();
  const sheetPath = 'review/contact-sheet.png';
  const directory = join(state.root, 'review');
  await mkdir(directory, { recursive: false }).catch(async (error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !(await lstat(directory)).isDirectory()) throw error;
  });
  try { await writeFile(join(directory, 'contact-sheet.png'), sheet, { flag: 'wx' }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    await readBoundImage(state.root, sheetPath, hash(sheet));
  }
  const contentManifest = EvidenceBundleManifestSchema.parse({ ...state.manifest,
    files: [...state.manifest.files, { relativePath: sheetPath, sha256: hash(sheet), bytes: sheet.length, role: 'imageInput' as const }]
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath)) });
  await verifyEvidenceBundle(state.root, contentManifest);
  const request = VisualReviewRequestSchema.parse({ requestId: randomUUID(), jobId: state.job.jobId, assetId: state.evidence.assetId,
    attempt: state.evidence.attempt, preAttestationContentSha256: bundleDigest(contentManifest), profileSha256: state.job.profile.profileSha256,
    sourceSha256: state.evidence.sourceSha256, toolSchemaSha256: state.evidence.toolSchemaSha256, reviewPolicySha256: state.policy.policySha256,
    artifacts: state.evidence.artifacts, contactSheet: { relativePath: sheetPath, sha256: hash(sheet) } });
  return { request, contentManifest, layout };
}

export type AttestationSubmission = { requestId: string; decision: 'approve' | 'reject'; notes: string };
export type AttestationAcceptanceInput = {
  state: TrustedVisualReviewState;
  request: VisualReviewRequest;
  storedProfiles: { plannerModelProfileId: string; reviewerModelProfileId: string; plannerProfileSha256: string; reviewerProfileSha256: string };
  submission: AttestationSubmission;
  trustedActorIdentity: string;
  expiresAt: string;
  nowMs?: number;
  existing?: HumanVisualAttestationV1;
};
export async function acceptVisualAttestation(input: AttestationAcceptanceInput): Promise<{
  status: 'accepted' | 'idempotent'; attestation: HumanVisualAttestationV1; bytes: Buffer;
  file: { relativePath: string; sha256: string; bytes: number }; authorizesPublication: boolean;
}> {
  assertState(input.state);
  const request = VisualReviewRequestSchema.parse(input.request);
  if (Object.keys(input.submission).sort().join(',') !== 'decision,notes,requestId') fail('submission may not supply actor or binding fields');
  if (!input.trustedActorIdentity.trim() || input.state.currentRequestId !== request.requestId || input.submission.requestId !== request.requestId) fail('stale request or missing trusted actor');
  if (input.storedProfiles.plannerModelProfileId !== input.state.job.modelProfileId || input.storedProfiles.reviewerModelProfileId !== input.state.job.reviewerModelProfileId
    || input.storedProfiles.plannerProfileSha256 !== input.state.plannerProfileSha256 || input.storedProfiles.reviewerProfileSha256 !== input.state.reviewerProfileSha256) fail('selected model profile binding changed');
  if (request.jobId !== input.state.job.jobId || request.assetId !== input.state.evidence.assetId || request.attempt !== input.state.currentAttempt
    || request.profileSha256 !== input.state.job.profile.profileSha256 || request.sourceSha256 !== input.state.evidence.sourceSha256
    || request.toolSchemaSha256 !== input.state.evidence.toolSchemaSha256 || request.reviewPolicySha256 !== input.state.policy.policySha256
    || canonicalize(request.artifacts) !== canonicalize(input.state.evidence.artifacts)) fail('stale attempt or request binding changed');
  const manifest = EvidenceBundleManifestSchema.parse(input.state.manifest);
  if (manifest.files.some((file) => file.role === 'humanAttestation') || bundleDigest(manifest) !== request.preAttestationContentSha256) fail('pre-attestation content drift');
  const contact = manifest.files.find((file) => file.relativePath === request.contactSheet.relativePath);
  if (!contact || contact.role !== 'imageInput' || contact.sha256 !== request.contactSheet.sha256) fail('contact sheet changed');
  await verifyEvidenceBundle(input.state.root, manifest);
  const now = input.nowMs ?? Date.now();
  const expires = Date.parse(input.expiresAt);
  if (!Number.isFinite(now) || !Number.isFinite(expires) || (!input.existing && now >= expires)) fail('request expired');
  if (input.submission.decision !== 'approve' && input.submission.decision !== 'reject') fail('invalid decision');
  const attestation = input.existing ? HumanVisualAttestationV1Schema.parse(input.existing) : HumanVisualAttestationV1Schema.parse({
    schemaVersion: 1, request, decision: input.submission.decision, notes: input.submission.notes,
    operatorIdentity: input.trustedActorIdentity, consumedAt: new Date(now).toISOString(), expiresAt: input.expiresAt });
  if (input.existing && (canonicalize(attestation.request) !== canonicalize(request) || attestation.decision !== input.submission.decision
    || attestation.notes !== input.submission.notes || attestation.operatorIdentity !== input.trustedActorIdentity)) fail('conflicting attestation replay');
  const bytes = Buffer.from(canonicalize(attestation));
  return { status: input.existing ? 'idempotent' : 'accepted', attestation, bytes,
    file: { relativePath: `review/attestation-${request.requestId}.json`, sha256: hash(bytes), bytes: bytes.length },
    authorizesPublication: attestation.decision === 'approve' };
}

export type AcceptedVisualAttestation = Awaited<ReturnType<typeof acceptVisualAttestation>>;
export type TrustedConsumedAttestation = { consumed: true; requestId: string; attestationSha256: string };

/** Called only after the attestation bytes have been durably written and the one-shot receipt consumed. */
export async function sealAttestedManifest(root: string, contentManifest: EvidenceBundleManifest, accepted: AcceptedVisualAttestation,
  receipt: TrustedConsumedAttestation): Promise<EvidenceBundleManifest> {
  const attestation = HumanVisualAttestationV1Schema.parse(accepted.attestation);
  if (!receipt.consumed || receipt.requestId !== attestation.request.requestId || receipt.attestationSha256 !== accepted.file.sha256)
    fail('trusted attestation receipt missing or changed');
  if (!accepted.authorizesPublication || attestation.decision !== 'approve') fail('rejected attestation cannot authorize publication');
  const content = EvidenceBundleManifestSchema.parse(contentManifest);
  if (content.files.some((file) => file.role === 'humanAttestation') || bundleDigest(content) !== attestation.request.preAttestationContentSha256)
    fail('pre-attestation content drift');
  if (!Buffer.from(canonicalize(attestation)).equals(accepted.bytes) || hash(accepted.bytes) !== accepted.file.sha256) fail('attestation bytes mismatch');
  await verifyEvidenceBundle(root, content);
  const bytes = await readBoundImage(root, accepted.file.relativePath, accepted.file.sha256);
  if (bytes.length !== accepted.file.bytes || !bytes.equals(accepted.bytes)) fail('attestation file changed');
  const sealed = EvidenceBundleManifestSchema.parse({ ...content,
    files: [...content.files, { relativePath: accepted.file.relativePath, sha256: accepted.file.sha256,
      bytes: accepted.file.bytes, role: 'humanAttestation' as const }].sort((a, b) => a.relativePath.localeCompare(b.relativePath)) });
  await verifyEvidenceBundle(root, sealed);
  return sealed;
}
