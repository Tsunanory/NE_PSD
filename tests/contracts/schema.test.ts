import { describe, expect, it } from 'vitest';
import {
  ConfigurationProposalSchema,
  InspectionReportSchema,
  JobEventSchema,
  ModelProfileSchema,
  ProfileSchema,
  TemplateProfileSchema,
  validateConfigurationProposal,
  validateQualificationResult,
  validateQualificationRequest,
} from '@ne-psd/contracts';
import { readFixture } from '../fixtures/read-fixture.js';

describe('contract v1 schemas', () => {
  it('accepts the complete qualified profile fixture', () => {
    const result = TemplateProfileSchema.safeParse(readFixture('profile.qualified.json'));
    expect(result.success).toBe(true);
  });

  it('rejects unknown keys at the trust boundary', () => {
    const fixture = readFixture<Record<string, unknown>>('inspection.static.json');
    const result = InspectionReportSchema.safeParse({ ...fixture, script: 'rm -rf /' });
    expect(result.success).toBe(false);
  });

  it('rejects duplicate variant IDs even with three outputs', () => {
    const fixture = readFixture<Record<string, unknown> & { variants: Array<Record<string, unknown>> }>('profile.qualified.json');
    const result = TemplateProfileSchema.safeParse({
      ...fixture,
      variants: [...fixture.variants.slice(0, 2), { ...fixture.variants[2], id: '2' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown inspection candidate and mismatched source', () => {
    const inspection = InspectionReportSchema.parse(readFixture('inspection.live.json'));
    const proposal = ConfigurationProposalSchema.parse(readFixture('proposal.valid.json'));
    const unknown = validateConfigurationProposal({
      ...proposal,
      targets: [{ ...proposal.targets[0], targetCandidateId: 'missing-candidate' }],
    }, inspection);
    expect(unknown.success).toBe(false);

    const request = readFixture<Record<string, unknown>>('qualification-request.json');
    const mismatched = validateQualificationRequest({
      ...request,
      proposal: { ...(request.proposal as Record<string, unknown>), inspectionId: 'other-inspection' },
    });
    expect(mismatched.success).toBe(false);

    const qualificationRequest = readFixture('qualification-request.json');
    const qualificationResult = readFixture<Record<string, unknown> & { candidate: Record<string, unknown> }>('qualification-result.json');
    const sourceMismatch = validateQualificationResult({
      ...qualificationResult,
      candidate: { ...qualificationResult.candidate, template: { ...(qualificationResult.candidate.template as Record<string, unknown>), sha256: 'f'.repeat(64) } },
    }, qualificationRequest);
    expect(sourceMismatch.success).toBe(false);
  });

  it('validates model provenance and job event fixtures', () => {
    expect(ModelProfileSchema.safeParse(readFixture('model.local.json')).success).toBe(true);
    expect(ModelProfileSchema.safeParse(readFixture('model.remote.json')).success).toBe(true);
    expect(JobEventSchema.safeParse(readFixture('job-event.running.json')).success).toBe(true);
  });
});
