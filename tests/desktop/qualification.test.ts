import { describe, expect, it } from 'vitest';
import { loadFixture } from '@ne-psd/contracts/testing';
import type { ConfigurationProposal, InspectionReport } from '@ne-psd/contracts';
import { qualifyInspection } from '../../apps/desktop/src/main/evidence.js';

const inspection = () => loadFixture<InspectionReport>('inspection.live.json');
const proposal = () => loadFixture<ConfigurationProposal>('proposal.valid.json');

describe('desktop template qualification', () => {
  it('requires structural selectors, live evidence and exactly three variants', () => {
    const result = qualifyInspection(inspection(), proposal(), '/tmp/template.psd', '/tmp/evidence');
    expect(result.status).toBe('qualified');
    if (result.status === 'qualified') expect(result.profile.variants.map((variant) => variant.id)).toEqual(['1', '2', '3']);

    const byName = structuredClone(proposal());
    byName.targets[0]!.targetCandidateId = 'Target';
    expect(qualifyInspection(inspection(), byName, '/tmp/template.psd', '/tmp/evidence').status).toBe('blocked');
  });

  it('invalidates changed source bytes, unsupported fit and ambiguous selectors', () => {
    const changed = inspection();
    changed.template.sha256 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    expect(qualifyInspection(changed, proposal(), '/tmp/template.psd', '/tmp/evidence').status).toBe('blocked');

    const unsupported = inspection();
    unsupported.capabilities!.supportedFitModes = ['cover'];
    const contain = structuredClone(proposal());
    contain.fitMode = 'contain';
    expect(qualifyInspection(unsupported, contain, '/tmp/template.psd', '/tmp/evidence').status).toBe('blocked');

    const ambiguous = inspection();
    ambiguous.candidates.push({ ...ambiguous.candidates[0]!, candidateId: 'target-duplicate' });
    expect(qualifyInspection(ambiguous, proposal(), '/tmp/template.psd', '/tmp/evidence').status).toBe('blocked');
  });
});
