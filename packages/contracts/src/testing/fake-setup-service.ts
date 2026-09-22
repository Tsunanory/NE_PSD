import {
  ConfigurationProposalSchema,
  InspectionReportSchema,
  ModelProfileSchema,
  TemplateProfileSchema,
  type ConfigurationProposal,
  type DomainError,
  type InspectionReport,
  type ModelProfile,
  type TemplateProfile,
} from '../index.js';
import type { SetupService } from '../services.js';
import {
  FakeFailureError,
  type FakeConfig,
  fixtureRoot,
  fixedClock,
  loadFixture,
  resolveFailureSchedule,
  testOnlyPath,
} from './fixture-loader.js';

export type FakeInspectionKind = 'static' | 'live';
export type FakeSetupOptions = FakeConfig & {
  readonly inspection?: FakeInspectionKind;
  readonly fixtureRoot?: string;
};

export class FakeSetupService implements SetupService {
  readonly testOnly = true as const;
  readonly inspectionKind: FakeInspectionKind;
  readonly clock;
  private readonly schedule;
  private readonly fixtureRootPath: string;

  constructor(options: FakeSetupOptions = {}) {
    this.inspectionKind = options.inspection ?? 'live';
    this.clock = options.clock ?? fixedClock();
    this.schedule = resolveFailureSchedule(options);
    this.fixtureRootPath = options.fixtureRoot ?? fixtureRoot();
  }

  async inspectTemplate(templatePath: string, signal: AbortSignal): Promise<InspectionReport> {
    this.throwIfAborted(signal);
    this.failIfScheduled('sourceChanged', 'storage:inspectTemplate');
    const name = this.inspectionKind === 'static' ? 'inspection.static.json' : 'inspection.live.json';
    const fixture = loadFixture<InspectionReport>(name, this.fixtureRootPath);
    const report = this.mapInspection(fixture, templatePath);
    return InspectionReportSchema.parse(report);
  }

  async proposeConfiguration(input: { instruction: string; inspectionId: string; modelProfileId: string }, signal: AbortSignal): Promise<ConfigurationProposal> {
    this.throwIfAborted(signal);
    this.failIfScheduled('storage:proposeConfiguration');
    const fixture = loadFixture<ConfigurationProposal>('proposal.valid.json', this.fixtureRootPath);
    return ConfigurationProposalSchema.parse({
      ...fixture,
      inspectionId: input.inspectionId,
      facts: fixture.facts.map((fact) => ({ ...fact, evidenceRefs: fact.evidenceRefs.map(testOnlyPath) })),
    });
  }

  async qualifyTemplate(input: { inspectionId: string; proposal: ConfigurationProposal; workingTemplatePath: string }, signal: AbortSignal): Promise<TemplateProfile> {
    this.throwIfAborted(signal);
    this.failIfScheduled('storage:qualifyTemplate');
    if (this.inspectionKind === 'static') throw new FakeFailureError('staticQualification', 'static inspection cannot qualify a live template');
    const fixture = loadFixture<TemplateProfile>('profile.qualified.json', this.fixtureRootPath);
    return TemplateProfileSchema.parse({
      ...fixture,
      template: { ...fixture.template, relativePath: testOnlyPath(input.workingTemplatePath.split(/[\\/]/).pop() ?? fixture.template.relativePath) },
    });
  }

  async inspectModelProfile(profile: ModelProfile, signal: AbortSignal): Promise<{ available: boolean; errors: DomainError[] }> {
    this.throwIfAborted(signal);
    const parsed = ModelProfileSchema.safeParse(profile);
    if (!parsed.success) return { available: false, errors: [this.error('INVALID_MODEL_PROFILE', 'validation', parsed.error.message, false)] };
    return { available: true, errors: [] };
  }

  async qualifyModelProfile(profile: ModelProfile, signal: AbortSignal): Promise<{ qualified: boolean; evidencePaths: string[]; errors: DomainError[] }> {
    const result = await this.inspectModelProfile(profile, signal);
    return {
      qualified: result.available && this.inspectionKind === 'live',
      evidencePaths: result.available ? ['testOnly/model/qualification.json'] : [],
      errors: result.errors,
    };
  }

  private mapInspection(fixture: InspectionReport, templatePath: string): InspectionReport {
    return {
      ...fixture,
      template: { ...fixture.template, relativePath: testOnlyPath(templatePath.split(/[\\/]/).pop() ?? fixture.template.relativePath) },
      evidencePaths: fixture.evidencePaths.map(testOnlyPath),
      documents: fixture.documents.map((document) => document.source === null ? document : { ...document, source: { ...document.source, relativePath: testOnlyPath(document.source.relativePath) } }),
      capabilities: fixture.capabilities === null ? null : { ...fixture.capabilities, evidencePaths: fixture.capabilities.evidencePaths.map(testOnlyPath) },
    };
  }

  private failIfScheduled(...names: string[]): void {
    for (const name of names) if (this.schedule.consume(name)) throw new FakeFailureError(name);
  }

  private error(code: string, category: DomainError['category'], message: string, retryable: boolean): DomainError {
    return { code, category, message, retryable, evidencePaths: ['testOnly/setup/errors.json'] };
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new DOMException('The operation was aborted', 'AbortError');
  }
}

export function createFakeSetupService(options: FakeSetupOptions = {}): FakeSetupService {
  return new FakeSetupService(options);
}
