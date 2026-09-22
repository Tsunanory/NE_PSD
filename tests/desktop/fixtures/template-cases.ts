import { loadFixture } from '@ne-psd/contracts/testing';
import type { ConfigurationProposal, InspectionReport } from '@ne-psd/contracts';
export const syntheticInspection = (): InspectionReport => loadFixture<InspectionReport>('inspection.live.json');
export const syntheticProposal = (): ConfigurationProposal => loadFixture<ConfigurationProposal>('proposal.valid.json');
