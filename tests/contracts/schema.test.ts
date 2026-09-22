import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { generatedSchema } from '../../scripts/generate-contract-schemas.mjs';
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

  it('rejects relationship-invalid proposals and static qualification requests', () => {
    const inspection = InspectionReportSchema.parse(readFixture('inspection.live.json'));
    const proposal = ConfigurationProposalSchema.parse(readFixture('proposal.valid.json'));
    const invalidRole = validateConfigurationProposal({ ...proposal, targets: [{ ...proposal.targets[0]!, targetCandidateId: 'reference-1' }] }, inspection);
    expect(invalidRole.success).toBe(false);
    const staticInspection = readFixture<Record<string, unknown>>('inspection.static.json');
    const request = readFixture<Record<string, unknown>>('qualification-request.json');
    const staticRequest = { ...request, inspection: staticInspection, proposal: { ...(request.proposal as Record<string, unknown>), inspectionId: staticInspection.inspectionId } };
    expect(validateQualificationRequest(staticRequest).success).toBe(false);
  });

  it('keeps checked-in Draft 2020-12 schemas deterministic and annotated', () => {
    const directory = resolve(process.cwd(), 'packages/contracts/schema/v1');
    for (const file of readdirSync(directory).filter((name) => name.endsWith('.json')).sort()) {
      const checkedIn = JSON.parse(readFileSync(resolve(directory, file), 'utf8'));
      expect(checkedIn).toEqual(generatedSchema(file, checkedIn));
      expect(checkedIn.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(checkedIn['x-runtime-only-invariants']).toBeInstanceOf(Array);
    }
    const template = JSON.parse(readFileSync(resolve(directory, 'template-profile.json'), 'utf8'));
    expect(template.properties.variants.minItems).toBe(3);
    expect(template.properties.variants.maxItems).toBe(3);
    expect(template.properties.variants.prefixItems.map((item: { properties: { id: { enum: string[] } } }) => item.properties.id.enum)).toEqual([['1', '2', '3'], ['1', '2', '3'], ['1', '2', '3']]);
    const manifest = JSON.parse(readFileSync(resolve(directory, 'evidence-bundle-manifest.json'), 'utf8'));
    expect(manifest.properties.files.items.properties.bytes.minimum).toBe(1);
    expect(manifest['x-runtime-only-invariants']).toContain('manifest relativePath uniqueness and self-hash exclusion');
  });
});
