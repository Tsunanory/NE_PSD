import { FakeSetupService as ContractFakeSetupService, fixtureRoot, loadFixture } from '@ne-psd/contracts/testing';
import type { ConfigurationProposal, InspectionReport, JobService, ModelProfile, ReviewPolicy, SetupService, TemplateProfile } from '@ne-psd/contracts';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { qualifyInspection } from './evidence.js';
import { FakeJobService, createFakeJobEvidenceAdapter } from './fake-job-service.js';
import type { JobEvidenceAdapter } from './job-session-controller.js';
import type { JobDetailAdapter } from './job-detail.js';
import { sha256File } from './setup-files.js';
import type { ModelOption, Preview } from './setup-controller.js';

export { FakeJobService } from './fake-job-service.js';
export class FakeSetupService extends ContractFakeSetupService {
  private readonly inspections = new Map<string, InspectionReport>();
  override async inspectTemplate(templatePath: string, signal: AbortSignal): Promise<InspectionReport> {
    const report = await super.inspectTemplate(templatePath, signal);
    const template = { rootId: randomUUID(), relativePath: basename(templatePath), sha256: await sha256File(templatePath) };
    const rebound = { ...report, template, documents: report.documents.map((document) => document.sourceKind === 'root' ? { ...document, source: template } : document) };
    this.inspections.set(rebound.inspectionId, rebound);
    return rebound;
  }
  override async qualifyTemplate(input: { inspectionId: string; proposal: ConfigurationProposal; workingTemplatePath: string }, signal: AbortSignal): Promise<TemplateProfile> {
    if (signal.aborted) throw new DOMException('The operation was aborted', 'AbortError');
    const inspection = this.inspections.get(input.inspectionId);
    if (!inspection || this.inspectionKind === 'static') throw new Error('live inspection required');
    const result = qualifyInspection(inspection, input.proposal, input.workingTemplatePath, '/tmp/ne-psd-evidence');
    if (result.status === 'blocked') throw new Error(result.reason);
    return result.profile;
  }
  async state(name: string): Promise<'ready' | 'blocked'> { return name === 'valid-text-only-model' ? 'ready' : 'blocked'; }
  readonly supportedStates = ['duplicate-layer-names', 'missing-target', 'unqualified-template', 'unsupported-contain', 'unsupported-stretch', 'missing-model', 'valid-text-only-model', 'invalid-artifact-digest'] as const;
}
export type DesktopServices = {
  jobs: JobService; setup: SetupService;
  models?: ModelOption[];
  reviewPolicySha256?: string;
  previews?: (profile: TemplateProfile) => Promise<Preview[]>;
  prepareLinkedCopy?: (source: string, destination: string, inspection: InspectionReport) => Promise<void>;
  developmentFake?: boolean;
  evidenceAdapter?: JobEvidenceAdapter;
  detailAdapter?: JobDetailAdapter;
};
export function composeServices(mode: 'development' | 'production', injected?: DesktopServices, explicitFake = false): DesktopServices {
  if (injected) return injected;
  if (mode === 'development' && explicitFake) {
    const profile = loadFixture<ModelProfile>('model.local.json');
    const provenance = profile.provenance;
    const evidence: ModelOption['evidence'] = {
      label: 'Qwen3.8-27B', modelId: profile.modelId,
      artifactSha256: provenance.kind === 'local' ? provenance.artifactSha256 : '',
      runtimeVersion: provenance.kind === 'local' ? provenance.runtimeVersion : '',
      chatTemplateSha256: provenance.kind === 'local' ? provenance.chatTemplateSha256 : '',
      quantization: 'Q4', contextTokens: profile.contextTokens, maxOutputTokens: profile.maxOutputTokens,
      capabilities: profile.capabilities, benchmark: { passed: true, latencyMs: 1 },
      resources: { peakRamGb: 1, peakVramGb: 1, requiredHeadroomGb: 1 },
      artifactVerified: true, endpointReachable: true, reviewGateAvailable: true, synthetic: true,
      selectedProfile: profile,
    };
    return {
      jobs: new FakeJobService(), setup: new FakeSetupService(), models: [{ profile, evidence }],
      reviewPolicySha256: loadFixture<ReviewPolicy>('policy.v1.json').policySha256,
      previews: async (qualified) => Promise.all((['1', '2', '3'] as const).map(async (variantId) => {
        const bytes = await readFile(join(fixtureRoot(), 'assets', `variant-${variantId}.jpg`));
        return { variantId, profileSha256: qualified.profileSha256, synthetic: true,
          sha256: createHash('sha256').update(bytes).digest('hex'), dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}` };
      })),
      developmentFake: true,
      evidenceAdapter: createFakeJobEvidenceAdapter(),
    };
  }
  throw new Error('desktop services are not configured');
}
