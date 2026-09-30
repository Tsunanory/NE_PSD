import { FakeJobService as ContractFakeJobService, FakeSetupService as ContractFakeSetupService } from '@ne-psd/contracts/testing';
import type { ConfigurationProposal, InspectionReport, JobSnapshot } from '@ne-psd/contracts';
import { qualifyInspection } from './evidence.js';
export class FakeJobService extends ContractFakeJobService {
  override async snapshot(jobId: string): Promise<Readonly<JobSnapshot>> {
    const snapshot = await super.snapshot(jobId);
    return Object.freeze(snapshot);
  }
}
export class FakeSetupService extends ContractFakeSetupService {
  private readonly inspections = new Map<string, InspectionReport>();
  override async inspectTemplate(templatePath: string, signal: AbortSignal): Promise<InspectionReport> {
    const report = await super.inspectTemplate(templatePath, signal); this.inspections.set(report.inspectionId, report); return report;
  }
  override async qualifyTemplate(input: { inspectionId: string; proposal: ConfigurationProposal; workingTemplatePath: string }, signal: AbortSignal) {
    if (signal.aborted) throw new DOMException('The operation was aborted', 'AbortError');
    const inspection = this.inspections.get(input.inspectionId); if (!inspection) throw new Error('unknown inspection');
    if (this.inspectionKind === 'static') throw new Error('static inspection cannot qualify a live template');
    const result = qualifyInspection(inspection, input.proposal, input.workingTemplatePath, '/tmp/ne-psd-evidence');
    if (result.status === 'blocked') throw new Error(result.reason);
    return result.profile;
  }
  async state(name: string): Promise<'ready' | 'blocked'> {
    return name === 'valid-text-only-model' ? 'ready' : 'blocked';
  }
  readonly supportedStates = ['duplicate-layer-names', 'missing-target', 'unqualified-template', 'unsupported-contain', 'unsupported-stretch', 'missing-model', 'valid-text-only-model', 'invalid-artifact-digest'] as const;
}

import type { JobService, SetupService } from '@ne-psd/contracts';

export type DesktopServices = { jobs: JobService; setup: SetupService };

export function composeServices(
  mode: 'development' | 'production',
  injected?: DesktopServices,
  explicitFake = false,
): DesktopServices {
  if (injected) return injected;
  if (mode === 'development' && explicitFake) return { jobs: new FakeJobService(), setup: new FakeSetupService() };
  throw new Error('desktop services are not configured');
}
