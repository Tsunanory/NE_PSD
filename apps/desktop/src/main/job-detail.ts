import { EvidenceBundleManifestSchema, JobSnapshotSchema, ReviewDecisionSchema,
  type EvidenceBundleManifest, type JobService, type ReviewDecision } from '@ne-psd/contracts';

export type JobDetailRecord = {
  review: ReviewDecision;
  manifest: EvidenceBundleManifest;
  diagnostics: Array<{ evidenceId: string; code: string; summary: string }>;
};
export type JobDetailAdapter = {
  assetAttempts(jobId: string, assetId: string): Promise<JobDetailRecord[]>;
};
export type AssetDetail = {
  available: boolean;
  synthetic: boolean;
  attempts: Array<{
    attempt: 1 | 2; reviewId: string; verdict: 'pass' | 'revise' | 'blocked';
    variants: Array<{ variantId: '1' | '2' | '3'; verdict: 'pass' | 'fail' | 'unknown'; evidenceIds: string[] }>;
    checks: Array<{ requirementId: string; result: 'pass' | 'fail' | 'unknown'; evidenceIds: string[]; reason: string }>;
    evidenceIds: string[];
    diagnostics: Array<{ evidenceId: string; code: string; summary: string }>;
  }>;
};

const digest = (value: string): boolean => /^[0-9a-f]{64}$/.test(value);
const safeCode = (value: string): boolean => /^[A-Z][A-Z0-9_]{0,63}$/.test(value);
const safeRequirement = (value: string): boolean => /^[A-Z][A-Z0-9_.]{0,99}$/.test(value);
function redact(summary: string): string {
  return summary.slice(0, 1024)
    .replace(/(?:file:\/\/|[A-Za-z]:[\\/]|\/)[^\s,;"']+/g, '[path]')
    .replace(/[\r\n\t]/g, ' ');
}

export async function readAssetDetail(jobs: JobService, adapter: JobDetailAdapter | undefined,
  jobId: string, assetId: string, synthetic: boolean): Promise<AssetDetail> {
  const snapshot = JobSnapshotSchema.parse(await jobs.snapshot(jobId));
  if (snapshot.jobId !== jobId || !snapshot.assets.some((asset) => asset.assetId === assetId)) throw new Error('asset is outside job snapshot');
  if (!adapter) return { available: false, synthetic, attempts: [] };
  const records = await adapter.assetAttempts(jobId, assetId);
  if (records.length > 2) throw new Error('too many review attempts');
  const seen = new Set<number>();
  const attempts: AssetDetail['attempts'] = records.map((record) => {
    const review = ReviewDecisionSchema.parse(record.review);
    const manifest = EvidenceBundleManifestSchema.parse(record.manifest);
    if (review.jobId !== jobId || review.assetId !== assetId || manifest.jobId !== jobId || manifest.assetId !== assetId ||
        review.attempt !== manifest.attempt || seen.has(review.attempt) || review.attempt > snapshot.assets.find((asset) => asset.assetId === assetId)!.attempt) {
      throw new Error('review detail is outside current job attempt');
    }
    seen.add(review.attempt);
    const files = new Map(manifest.files.map((file) => [file.relativePath, file.sha256]));
    const ids = (refs: string[]): string[] => refs.map((ref) => {
      const id = files.get(ref);
      if (!id) throw new Error('review reference absent from manifest');
      return id;
    });
    const evidenceIds = [...new Set([
      ...review.variantChecks.flatMap((check) => ids(check.evidenceRefs)),
      ...review.checks.flatMap((check) => ids(check.evidenceRefs)),
      ...review.findings.flatMap((finding) => ids(finding.evidenceRefs)),
    ])];
    if (review.checks.length > 100 || review.checks.some((check) => !safeRequirement(check.requirementId))) {
      throw new Error('review checks are not bounded');
    }
    if (record.diagnostics.length > 20) throw new Error('too many diagnostics');
    const diagnostics = record.diagnostics.map((item) => {
      if (!digest(item.evidenceId) || !evidenceIds.includes(item.evidenceId) || !safeCode(item.code) || item.summary.length > 4096) {
        throw new Error('diagnostic is not bound to review evidence');
      }
      return { evidenceId: item.evidenceId, code: item.code, summary: redact(item.summary) };
    });
    return {
      attempt: review.attempt, reviewId: review.reviewId, verdict: review.verdict,
      variants: review.variantChecks.map((check) => ({ variantId: check.variantId, verdict: check.verdict, evidenceIds: ids(check.evidenceRefs) })),
      checks: review.checks.map((check) => ({ requirementId: check.requirementId, result: check.result,
        evidenceIds: ids(check.evidenceRefs), reason: redact(check.reason) })),
      evidenceIds, diagnostics,
    };
  });
  return { available: true, synthetic, attempts: attempts.sort((a, b) => a.attempt - b.attempt) };
}
