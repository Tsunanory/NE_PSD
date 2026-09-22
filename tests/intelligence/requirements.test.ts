import { describe, expect, it } from 'vitest';
import { ReviewPolicySchema } from '@ne-psd/contracts';
import { MANDATORY_REQUIREMENTS, createReviewPolicy } from '@ne-psd/intelligence';

describe('mandatory review policy', () => {
  it('contains the frozen fifteen mandatory requirement IDs', () => {
    expect(MANDATORY_REQUIREMENTS).toHaveLength(15);
    expect(MANDATORY_REQUIREMENTS.every((entry) => entry.mandatory)).toBe(true);
    expect(ReviewPolicySchema.parse(createReviewPolicy()).requirements.map((entry) => entry.id)).toEqual([
      'BINDING.CURRENT_ATTEMPT', 'MANIFEST.COMPLETE', 'ARTIFACTS.EXACTLY_THREE', 'IMAGE.DECODE_FORMAT',
      'IMAGE.DIMENSIONS_COLOR', 'GEOMETRY.REQUESTED_FIT', 'CLIPPING.ALPHA_ADJACENCY', 'VARIANTS.VISIBILITY',
      'SMART_OBJECT.LINEAGE_PROPAGATION', 'SAFETY.LINKED_ISOLATION', 'SAFETY.ORIGINALS_UNCHANGED',
      'SAFETY.DOCUMENT_OWNERSHIP', 'IMAGE.QUALITY', 'VISUAL.QUALIFIED', 'EVIDENCE.TRACE_COMPLETE',
    ]);
  });

  it('hashes the policy using foundation canonicalization without self-reference', () => {
    const policy = createReviewPolicy();
    expect(policy.policySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(createReviewPolicy().policySha256).toBe(policy.policySha256);
  });

  it('uses a human evaluator for explicit human-per-asset mode', () => {
    const policy = createReviewPolicy({ visualGate: 'humanPerAsset' });
    expect(policy.requirements.find((entry) => entry.id === 'VISUAL.QUALIFIED')?.evaluator).toBe('human');
  });
});
