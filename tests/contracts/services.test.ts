import { describe, expect, it } from 'vitest';
import {
  ModelProfileSchema,
  ReviewDecisionSchema,
  VisualReviewRequestSchema,
  validateJobSpec,
  validateModelProfile,
  validateReviewDecision,
} from '@ne-psd/contracts';
import { readFixture } from '../fixtures/read-fixture.js';

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
});
