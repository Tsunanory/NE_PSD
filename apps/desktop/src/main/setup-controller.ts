import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import sharp from 'sharp';
import {
  ConfigurationProposalSchema, InspectionReportSchema, JobSpecSchema, ModelProfileSchema,
  TemplateProfileSchema, sha256Json, validateConfigurationProposal,
  type Asset, type ConfigurationProposal, type InspectionReport, type JobService,
  type JobSpec, type ModelProfile, type SetupService, type TemplateProfile,
} from '@ne-psd/contracts';
import type { ModelEvidence } from '../renderer/setup/model-state.js';
import { evaluateModelSelection } from '../renderer/setup/model-state.js';
import { RootRegistry } from './paths.js';
import { canonicalExisting, inspectAssets, probeOutputDirectory, sha256File, validateSetupRoots, type AssetInspection } from './setup-files.js';

export type PickerKind = 'template' | 'assets' | 'output';
export type Pickers = { select(kind: PickerKind): Promise<string | null> };
export type Preview = { variantId: '1' | '2' | '3'; profileSha256: string; sha256: string; dataUrl: string; synthetic: boolean };
export type ModelOption = { profile: ModelProfile; evidence: ModelEvidence };
export type SetupControllerOptions = {
  setup: SetupService; jobs: JobService; roots: RootRegistry; pickers: Pickers;
  userDataDirectory: string; models: ModelOption[]; reviewPolicySha256: string; developmentFake: boolean;
  previews?: (profile: TemplateProfile) => Promise<Preview[]>;
  prepareLinkedCopy?: (source: string, destination: string, inspection: InspectionReport) => Promise<void>;
};
export type TemplateSelection = { handle: string; label: string; relativePath: string; sha256: string };
export type AssetSelection = { rootHandle: string; label: string; assets: Asset[]; rejected: AssetInspection['rejected'] };
export type OutputSelection = { rootHandle: string; label: string; freeBytes: number };

const savedCandidateSchema = z.object({ schemaVersion: z.literal(1), templateSha256: z.string().regex(/^[0-9a-f]{64}$/), toolSchemaSha256: z.string().regex(/^[0-9a-f]{64}$/), proposal: ConfigurationProposalSchema }).strict();
const savedProfileSchema = z.object({ schemaVersion: z.literal(1), profile: TemplateProfileSchema }).strict();
async function validPreview(value: Preview, profile: TemplateProfile, developmentFake: boolean): Promise<boolean> {
  if (value.profileSha256 !== profile.profileSha256 || !/^[0-9a-f]{64}$/.test(value.sha256) ||
      value.synthetic !== developmentFake || value.dataUrl.length >= 10_000_000) return false;
  const match = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value.dataUrl);
  if (!match) return false;
  const bytes = Buffer.from(match[2]!, 'base64');
  if (!bytes.length || bytes.toString('base64') !== match[2] || createHash('sha256').update(bytes).digest('hex') !== value.sha256) return false;
  try {
    const image = sharp(bytes, { failOn: 'error', limitInputPixels: 20_000_000 });
    const metadata = await image.metadata();
    if (metadata.format !== match[1] || !metadata.width || !metadata.height ||
        (!developmentFake && (metadata.width !== profile.output.width || metadata.height !== profile.output.height))) return false;
    await image.raw().toBuffer();
    return true;
  } catch { return false; }
}

export class SetupController {
  private template: (TemplateSelection & { path: string }) | null = null;
  private assets: AssetSelection | null = null;
  private assetDirectory: string | null = null;
  private output: (OutputSelection & { path: string }) | null = null;
  private inspection: InspectionReport | null = null;
  private proposal: ConfigurationProposal | null = null;
  private pending: { profile: TemplateProfile; previews: Preview[] } | null = null;
  private sealed: TemplateProfile | null = null;
  private plannerId: string | null = null;
  private reviewerId: string | null = null;
  private readonly modelQualifications = new Map<string, { profileSha256: string; evidence: ModelEvidence }>();

  constructor(private readonly options: SetupControllerOptions) {
    if (!/^[0-9a-f]{64}$/.test(options.reviewPolicySha256)) throw new Error('review policy digest missing');
    for (const option of options.models) ModelProfileSchema.parse(option.profile);
  }

  currentTemplate(): TemplateSelection | null {
    if (!this.template) return null;
    const { path: _path, ...publicSelection } = this.template;
    return publicSelection;
  }
  currentProfile(): TemplateProfile | null { return this.sealed; }
  currentInspection(): InspectionReport | null { return this.inspection; }
  catalog(): { models: ModelOption[]; reviewPolicySha256: string; developmentFake: boolean } {
    return { models: this.options.models.map((option) => {
      const qualified = this.modelQualifications.get(option.profile.profileId);
      const { qualification: _untrustedQualification, ...catalogEvidence } = option.evidence;
      return { profile: option.profile, evidence: qualified?.profileSha256 === sha256Json(option.profile) ? qualified.evidence : catalogEvidence };
    }), reviewPolicySha256: this.options.reviewPolicySha256, developmentFake: this.options.developmentFake };
  }

  private invalidate(): void { this.inspection = null; this.proposal = null; this.pending = null; this.sealed = null; }

  async chooseTemplate(): Promise<TemplateSelection | null> {
    const chosen = await this.options.pickers.select('template'); if (chosen === null) return null;
    const path = canonicalExisting(chosen);
    if (extname(path).toLowerCase() !== '.psd' || !statSync(path).isFile()) throw new Error('selected template must be a PSD file');
    const handle = this.options.roots.register('template', dirname(path));
    const selection = { handle, label: basename(path), relativePath: basename(path), sha256: await sha256File(path), path };
    if (this.template) this.options.roots.revoke(this.template.handle);
    this.template = selection; this.invalidate();
    if (this.output && this.assetDirectory) validateSetupRoots(path, this.assetDirectory, this.output.path);
    return this.currentTemplate();
  }

  async chooseAssets(): Promise<AssetSelection | null> {
    const chosen = await this.options.pickers.select('assets'); if (chosen === null) return null;
    const path = canonicalExisting(chosen);
    if (!statSync(path).isDirectory()) throw new Error('selected input must be a directory');
    if (this.template && this.output) validateSetupRoots(this.template.path, path, this.output.path);
    const rootHandle = this.options.roots.register('assets', path);
    const inspected = await inspectAssets(path, rootHandle);
    if (this.assets) this.options.roots.revoke(this.assets.rootHandle);
    this.assets = { rootHandle, label: basename(path), ...inspected };
    this.assetDirectory = path; this.pending = null; this.sealed = null;
    return this.assets;
  }

  async chooseOutput(): Promise<OutputSelection | null> {
    const chosen = await this.options.pickers.select('output'); if (chosen === null) return null;
    const path = canonicalExisting(chosen);
    if (!statSync(path).isDirectory()) throw new Error('selected output must be a directory');
    if (this.template && this.assetDirectory) validateSetupRoots(this.template.path, this.assetDirectory, path);
    const freeBytes = probeOutputDirectory(path);
    const rootHandle = this.options.roots.register('output', path);
    if (this.output) this.options.roots.revoke(this.output.rootHandle);
    this.output = { rootHandle, label: basename(path), freeBytes, path };
    this.pending = null; this.sealed = null;
    const { path: _path, ...publicSelection } = this.output;
    return publicSelection;
  }

  async inspect(): Promise<InspectionReport> {
    const selected = this.template;
    if (!selected || await sha256File(selected.path) !== selected.sha256) throw new Error('template changed; choose it again');
    const report = InspectionReportSchema.parse(await this.options.setup.inspectTemplate(selected.path, new AbortController().signal));
    if (report.template.sha256 !== selected.sha256) throw new Error('inspection template digest mismatch');
    this.inspection = report; this.proposal = null; this.pending = null; this.sealed = null;
    return report;
  }

  async propose(instruction: string, modelProfileId: string): Promise<ConfigurationProposal> {
    if (!this.inspection || !instruction.trim() || !this.options.models.some((option) => option.profile.profileId === modelProfileId)) throw new Error('inspection and selected model required');
    const proposal = ConfigurationProposalSchema.parse(await this.options.setup.proposeConfiguration({ instruction, inspectionId: this.inspection.inspectionId, modelProfileId }, new AbortController().signal));
    if (proposal.inspectionId !== this.inspection.inspectionId) throw new Error('proposal inspection mismatch');
    this.proposal = proposal; this.pending = null; this.sealed = null;
    return proposal;
  }

  async qualify(input: ConfigurationProposal): Promise<{ profile: TemplateProfile; previews: Preview[] }> {
    const selected = this.template; const inspection = this.inspection;
    if (!selected || !inspection || !this.proposal) throw new Error('inspect and propose before qualification');
    if (await sha256File(selected.path) !== selected.sha256) { this.invalidate(); throw new Error('template changed before qualification'); }
    const proposal = ConfigurationProposalSchema.parse(input);
    if (proposal.inspectionId !== inspection.inspectionId || proposal.status !== 'proposed' || proposal.output === null) throw new Error('incomplete proposal');
    const checked = validateConfigurationProposal(proposal, inspection);
    if (!checked.success) throw new Error('proposal does not match inspected selectors');
    if (!inspection.capabilities?.supportedFitModes.includes(proposal.fitMode)) throw new Error('fit mode is not qualified');
    if (inspection.unresolvedLinks.length > 0) throw new Error('unresolved linked dependencies');
    const workingDir = join(this.options.userDataDirectory, 'working', randomUUID());
    await mkdir(workingDir, { recursive: true, mode: 0o700 });
    const workingPath = join(workingDir, basename(selected.path));
    if (inspection.documents.some((document) => document.sourceKind === 'linked')) {
      if (!this.options.prepareLinkedCopy) throw new Error('linked dependency isolation adapter is unavailable');
      await this.options.prepareLinkedCopy(selected.path, workingPath, inspection);
    } else await copyFile(selected.path, workingPath);
    if (!existsSync(workingPath) || realpathSync(workingPath) !== join(realpathSync(workingDir), basename(workingPath)) || await sha256File(workingPath) !== selected.sha256) throw new Error('working copy does not match source');
    const profile = TemplateProfileSchema.parse(await this.options.setup.qualifyTemplate({ inspectionId: inspection.inspectionId, proposal, workingTemplatePath: workingPath }, new AbortController().signal));
    this.assertProfileBinding(profile, proposal, inspection, selected);
    this.options.roots.adopt(profile.template.rootId, 'template', this.rootForProfile(profile, selected.path));
    const previews = await this.options.previews?.(profile);
    if (!previews || previews.length !== 3 || previews.map((preview) => preview.variantId).join(',') !== '1,2,3' ||
        !(await Promise.all(previews.map((preview) => validPreview(preview, profile, this.options.developmentFake)))).every(Boolean)) throw new Error('three bound image previews are required');
    this.proposal = proposal; this.pending = { profile, previews }; this.sealed = null;
    return this.pending;
  }

  async confirmPreviews(profileSha256: string): Promise<TemplateProfile> {
    if (!this.pending || this.pending.profile.profileSha256 !== profileSha256 || !this.template || await sha256File(this.template.path) !== this.template.sha256) throw new Error('stale preview confirmation');
    this.sealed = this.pending.profile;
    return this.sealed;
  }

  selectModels(plannerProfileId: string, reviewerProfileId: string): void {
    if (!this.options.models.some((option) => option.profile.profileId === plannerProfileId) || !this.options.models.some((option) => option.profile.profileId === reviewerProfileId)) throw new Error('unknown model profile');
    this.plannerId = plannerProfileId; this.reviewerId = reviewerProfileId;
  }
  async inspectModel(profile: ModelProfile) {
    const selected = this.options.models.find((option) => option.profile.profileId === profile.profileId);
    if (!selected || JSON.stringify(selected.profile) !== JSON.stringify(profile)) throw new Error('model is outside trusted catalog');
    return this.options.setup.inspectModelProfile(profile, new AbortController().signal);
  }
  async qualifyModel(profile: ModelProfile) {
    this.modelQualifications.delete(profile.profileId);
    const inspection = await this.inspectModel(profile);
    if (!inspection.available) throw new Error('model endpoint is unavailable');
    const result = await this.options.setup.qualifyModelProfile(profile, new AbortController().signal);
    const selected = this.options.models.find((option) => option.profile.profileId === profile.profileId)!;
    this.modelQualifications.set(profile.profileId, {
      profileSha256: sha256Json(profile),
      evidence: { ...selected.evidence, selectedProfile: profile, endpointReachable: inspection.available, qualification: result },
    });
    return result;
  }

  private qualifiedEvidence(profileId: string): ModelEvidence {
    const option = this.options.models.find((item) => item.profile.profileId === profileId);
    const record = this.modelQualifications.get(profileId);
    if (!option || !record || record.profileSha256 !== sha256Json(option.profile) ||
        record.evidence.qualification?.qualified !== true || record.evidence.qualification.errors.length !== 0 ||
        record.evidence.qualification.evidencePaths.length === 0) throw new Error('model qualification is stale');
    return record.evidence;
  }

  async startJob(): Promise<{ jobId: string }> {
    if (!this.sealed || !this.template || !this.assets || !this.assetDirectory || !this.output || !this.plannerId || !this.reviewerId) throw new Error('setup is incomplete');
    if (await sha256File(this.template.path) !== this.template.sha256) { this.sealed = null; throw new Error('template changed'); }
    const currentAssets = await inspectAssets(this.assetDirectory, this.assets.rootHandle);
    if (JSON.stringify(currentAssets.assets) !== JSON.stringify(this.assets.assets)) throw new Error('assets changed');
    validateSetupRoots(this.template.path, this.assetDirectory, this.output.path);
    probeOutputDirectory(this.output.path);
    const planner = this.options.models.find((option) => option.profile.profileId === this.plannerId)!;
    const reviewer = this.options.models.find((option) => option.profile.profileId === this.reviewerId)!;
    const plannerEvidence = this.qualifiedEvidence(this.plannerId);
    const reviewerEvidence = this.qualifiedEvidence(this.reviewerId);
    if (!this.options.developmentFake && !evaluateModelSelection(plannerEvidence, reviewerEvidence).ready) throw new Error('model evidence or capacity is incomplete');
    if (!reviewer.profile.capabilities.vision) throw new Error('selected reviewer has no vision capability');
    const spec = JobSpecSchema.parse({ schemaVersion: 1, jobId: randomUUID(), profile: this.sealed, assets: this.assets.assets, outputRootId: this.output.rootHandle, modelProfileId: this.plannerId, reviewerModelProfileId: this.reviewerId, reviewPolicySha256: this.options.reviewPolicySha256, trigger: 'interactive', maxAttempts: 2 });
    this.options.roots.assertJobSpec(spec);
    const checked = await this.options.jobs.validate(spec);
    if (!checked.valid) throw new Error('job validation failed');
    return this.options.jobs.start(spec);
  }

  async assertCurrentSpec(spec: JobSpec): Promise<void> {
    if (!this.sealed || !this.template || !this.assets || !this.assetDirectory || !this.output || spec.profile.profileSha256 !== this.sealed.profileSha256 || spec.outputRootId !== this.output.rootHandle || JSON.stringify(spec.assets) !== JSON.stringify(this.assets.assets) || spec.reviewPolicySha256 !== this.options.reviewPolicySha256 || spec.trigger !== 'interactive' || spec.modelProfileId !== this.plannerId || spec.reviewerModelProfileId !== this.reviewerId) throw new Error('JobSpec is not bound to current setup');
    if (await sha256File(this.template.path) !== this.template.sha256 || JSON.stringify((await inspectAssets(this.assetDirectory, this.assets.rootHandle)).assets) !== JSON.stringify(this.assets.assets)) throw new Error('source changed before job submission');
    const plannerEvidence = this.qualifiedEvidence(this.plannerId!);
    const reviewerEvidence = this.qualifiedEvidence(this.reviewerId!);
    if (!this.options.developmentFake && !evaluateModelSelection(plannerEvidence, reviewerEvidence).ready) throw new Error('model evidence or capacity is incomplete');
    probeOutputDirectory(this.output.path);
    this.options.roots.assertJobSpec(spec);
  }

  async saveCandidate(proposal: ConfigurationProposal): Promise<void> {
    if (!this.inspection || !this.template || !this.inspection.capabilities) throw new Error('inspection required');
    const checked = validateConfigurationProposal(proposal, this.inspection);
    if (!checked.success) throw new Error('candidate is invalid');
    await this.atomicSave('candidate.json', savedCandidateSchema.parse({ schemaVersion: 1, templateSha256: this.template.sha256, toolSchemaSha256: this.inspection.capabilities.toolSchemaSha256, proposal }));
  }
  async loadCandidate(): Promise<ConfigurationProposal> {
    if (!this.inspection || !this.template || !this.inspection.capabilities) throw new Error('reselect and inspect the template');
    const saved = savedCandidateSchema.parse(await this.readSaved('candidate.json'));
    if (saved.templateSha256 !== this.template.sha256 || saved.toolSchemaSha256 !== this.inspection.capabilities.toolSchemaSha256 || saved.proposal.inspectionId !== this.inspection.inspectionId) throw new Error('saved candidate is stale');
    const checked = validateConfigurationProposal(saved.proposal, this.inspection);
    if (!checked.success) throw new Error('saved candidate selectors are stale');
    this.proposal = saved.proposal; this.pending = null; this.sealed = null;
    return saved.proposal;
  }
  async saveProfile(): Promise<void> {
    if (!this.sealed) throw new Error('no confirmed qualified profile');
    await this.atomicSave('profile.json', savedProfileSchema.parse({ schemaVersion: 1, profile: this.sealed }));
  }
  async loadProfile(): Promise<TemplateProfile> {
    if (!this.inspection || !this.template) throw new Error('reselect and inspect the template');
    const saved = savedProfileSchema.parse(await this.readSaved('profile.json')).profile;
    if (saved.template.sha256 !== this.template.sha256 || saved.toolSchemaSha256 !== this.inspection.capabilities?.toolSchemaSha256) throw new Error('saved profile is stale');
    this.rootForProfile(saved, this.template.path);
    this.pending = null; this.sealed = null;
    return saved; // Stored evidence is displayed only; live qualification must run again.
  }

  private assertProfileBinding(profile: TemplateProfile, proposal: ConfigurationProposal, inspection: InspectionReport, selected: TemplateSelection & { path: string }): void {
    const { profileSha256, ...content } = profile;
    if (sha256Json(content) !== profileSha256) throw new Error('profile digest mismatch');
    if (profile.template.sha256 !== selected.sha256 || profile.toolSchemaSha256 !== inspection.capabilities?.toolSchemaSha256 || profile.backendId !== inspection.capabilities.backendId) throw new Error('profile qualification binding mismatch');
    if (profile.fitMode !== proposal.fitMode || JSON.stringify(profile.output) !== JSON.stringify(proposal.output)) throw new Error('profile geometry policy changed');
    const candidates = new Map(inspection.candidates.map((candidate) => [candidate.candidateId, candidate.selector]));
    const proposed = proposal.targets[0]!; const target = profile.targets[0]!;
    if (JSON.stringify(target.target) !== JSON.stringify(candidates.get(proposed.targetCandidateId)) || JSON.stringify(target.reference) !== JSON.stringify(candidates.get(proposed.referenceCandidateId))) throw new Error('qualified selectors differ from proposal');
    for (let index = 0; index < 3; index++) if (profile.variants[index]?.id !== proposal.variants[index]?.id || JSON.stringify(profile.variants[index]?.group) !== JSON.stringify(candidates.get(proposal.variants[index]!.groupCandidateId))) throw new Error('qualified variants differ from proposal');
    this.rootForProfile(profile, selected.path);
  }
  private rootForProfile(profile: TemplateProfile, selectedPath: string): string {
    const relativePath = profile.template.relativePath.split('/').join(sep);
    if (!selectedPath.endsWith(`${sep}${relativePath}`)) throw new Error('profile file reference differs from selected template');
    const root = selectedPath.slice(0, -relativePath.length - 1) || sep;
    if (resolve(root, relativePath) !== selectedPath) throw new Error('profile root cannot be rebound');
    return root;
  }
  private async atomicSave(name: string, value: unknown): Promise<void> {
    await mkdir(this.options.userDataDirectory, { recursive: true, mode: 0o700 });
    const temporary = join(this.options.userDataDirectory, `.${name}.${randomUUID()}`);
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await rename(temporary, join(this.options.userDataDirectory, name));
  }
  private async readSaved(name: string): Promise<unknown> {
    const path = join(this.options.userDataDirectory, name);
    if (!existsSync(path) || realpathSync(path) !== path || statSync(path).size > 1_000_000) throw new Error('saved setup is missing or unsafe');
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  }
}
