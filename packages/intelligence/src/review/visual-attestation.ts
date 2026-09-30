import { bundleDigest, canonicalize, VisualReviewRequestSchema, type VisualReviewRequest } from '@ne-psd/contracts';
import type { EvidenceSnapshot } from './evidence-validator.js';

/** Receipt and identity are supplied only by A's trusted one-shot persistence reader. */
export type TrustedVisualAttestation = {
  request: VisualReviewRequest;
  decision: 'approve' | 'reject';
  operatorIdentity: string;
  consumed: true;
  consumedAt: string;
  expiresAt: string;
  attestationRelativePath: string;
  attestationSha256: string;
};
export type TrustedAttestationReader = (jobId: string, assetId: string, attempt: 1 | 2) => Promise<TrustedVisualAttestation | null>;

/** This checks A's consumed record; request creation, identity and replay prevention remain A-owned. */
export async function validateVisualAttestation(snapshot: EvidenceSnapshot, readTrustedAttestation: TrustedAttestationReader, nowMs = Date.now()): Promise<TrustedVisualAttestation> {
  if (snapshot.policy.visualGate !== 'humanPerAsset') throw new Error('ATTESTATION_POLICY_MISMATCH');
  const record = await readTrustedAttestation(snapshot.job.jobId, snapshot.manifest.assetId, snapshot.manifest.attempt);
  if (!record || record.consumed !== true || record.decision !== 'approve' || !record.operatorIdentity.trim()) throw new Error('ATTESTATION_MISSING_REJECTED_OR_UNTRUSTED');
  const request = VisualReviewRequestSchema.parse(record.request);
  const consumedAt = Date.parse(record.consumedAt), expiresAt = Date.parse(record.expiresAt);
  if (!Number.isFinite(consumedAt) || !Number.isFinite(expiresAt) || consumedAt > nowMs || consumedAt > expiresAt || nowMs > expiresAt) throw new Error('ATTESTATION_EXPIRED');
  if (request.jobId !== snapshot.job.jobId || request.assetId !== snapshot.manifest.assetId || request.attempt !== snapshot.manifest.attempt ||
      request.profileSha256 !== snapshot.job.profile.profileSha256 || request.sourceSha256 !== snapshot.evidence.sourceSha256 ||
      request.toolSchemaSha256 !== snapshot.evidence.toolSchemaSha256 || request.reviewPolicySha256 !== snapshot.policy.policySha256) throw new Error('ATTESTATION_SUBJECT_OR_PROVENANCE_MISMATCH');
  const contentManifest = { ...snapshot.manifest, files: snapshot.manifest.files.filter((file) => file.role !== 'humanAttestation') };
  if (request.preAttestationContentSha256 !== bundleDigest(contentManifest)) throw new Error('ATTESTATION_CONTENT_CHANGED');
  if (canonicalize(request.artifacts) !== canonicalize(snapshot.evidence.artifacts)) throw new Error('ATTESTATION_ARTIFACT_MISMATCH');
  const contact = snapshot.manifest.files.find((file) => file.relativePath === request.contactSheet.relativePath);
  if (!contact || contact.role !== 'imageInput' || contact.sha256 !== request.contactSheet.sha256) throw new Error('ATTESTATION_CONTACT_SHEET_MISMATCH');
  const attestation = snapshot.manifest.files.find((file) => file.relativePath === record.attestationRelativePath);
  if (!attestation || attestation.role !== 'humanAttestation' || attestation.sha256 !== record.attestationSha256) throw new Error('ATTESTATION_FILE_MISMATCH');
  await snapshot.assertUnchanged();
  return record;
}
