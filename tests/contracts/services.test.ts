import { describe, expect, it } from 'vitest';
import {
  ModelProfileSchema,
  ReviewDecisionSchema,
  VisualReviewRequestSchema,
  JobSpecSchema,
  validateJobSpec,
  validateModelProfile,
  validateReviewDecision,
} from '@ne-psd/contracts';
import { readFixture } from '../fixtures/read-fixture.js';
import { FakeJobService } from '../../packages/contracts/src/testing/fake-job-service.js';

describe('contract service boundary validation', () => {
  it('rejects scheduled Qwen jobs and local models masquerading as remote', () => {
    const local = readFixture<Record<string, unknown>>('model.local.json');
    expect(validateJobSpec({ ...readFixture('job.interactive.json'), trigger: 'scheduled' }, { ...local, provider: 'local-qwen' }).success).toBe(false);
    expect(ModelProfileSchema.safeParse({
      ...local,
      provider: 'local-qwen',
      provenance: { kind: 'remote', provider: 'luna', modelId: 'luna', revision: null, qualificationEvidencePath: 'evidence.json' },
    }).success).toBe(false);
  });

  it('rejects malformed artifact tuples and changed review-policy digests', () => {
    const request = readFixture<Record<string, unknown>>('visual-review-request.json');
    expect(VisualReviewRequestSchema.safeParse({ ...request, artifacts: (request.artifacts as unknown[]).slice(0, 2) }).success).toBe(false);
    const review = ReviewDecisionSchema.parse(readFixture('review.pass.json'));
    expect(validateReviewDecision({ ...review, reviewPolicySha256: 'f'.repeat(64) }, 'a'.repeat(64)).success).toBe(false);
  });

  it('creates a successor retry, binds review to the current attempt, and attests idempotently', async () => {
    const spec = JobSpecSchema.parse(readFixture('job.interactive.json'));
    const service = new FakeJobService();
    await service.start(spec);
    const first = await service.visualReview(spec.jobId, spec.assets[0]!.assetId);
    expect(first?.attempt).toBe((await service.snapshot(spec.jobId)).assets[0]!.attempt);
    expect(first).not.toBeNull();
    await service.submitVisualAttestation(first!.requestId, 'approve', 'ok');
    await service.submitVisualAttestation(first!.requestId, 'approve', 'ok');
    await expect(service.submitVisualAttestation(first!.requestId, 'reject', 'changed')).rejects.toThrow(/conflicting/);
    const retry = await service.retryFailed(spec.jobId);
    expect(retry.jobId).not.toBe(spec.jobId);
    expect((await service.snapshot(spec.jobId)).jobId).toBe(spec.jobId);
    const successorRequest = await service.visualReview(retry.jobId, spec.assets[0]!.assetId);
    expect(successorRequest?.jobId).toBe(retry.jobId);
    await expect(service.submitVisualAttestation(first!.requestId, 'approve', 'ok')).rejects.toThrow(/stale/);
  });
});
