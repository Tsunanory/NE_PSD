import { canonicalize } from '@ne-psd/contracts';
import type { EvidenceSnapshot } from './evidence-validator.js';

/** Assemble one complete, bound request from the already validated retained snapshot. */
export async function prepareEvidenceRequest(snapshot: EvidenceSnapshot) {
  await snapshot.assertUnchanged();
  const images = snapshot.manifest.visionInputs.map((input) => ({
    ...input,
    bytes: snapshot.getBytes(input.relativePath),
  }));
  const userData = {
    kind: 'asset-review' as const,
    schemaVersion: 1 as const,
    jobId: snapshot.job.jobId,
    assetId: snapshot.manifest.assetId,
    attempt: snapshot.manifest.attempt,
    evidenceSha256: snapshot.evidenceSha256,
    reviewPolicySha256: snapshot.policy.policySha256,
    manifest: snapshot.manifest,
    renderEvidence: snapshot.evidence,
  };
  return { userData, userText: canonicalize(userData), images };
}
