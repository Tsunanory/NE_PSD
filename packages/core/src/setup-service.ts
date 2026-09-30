import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import {
  ConfigurationProposalSchema,
  InspectionReportSchema,
  ModelProfileSchema,
  ModelQualificationResultSchema,
  QualificationResultSchema,
  TemplateProfileSchema,
  sha256Json,
  validateConfigurationProposal,
  type ConfigurationProposal,
  type InspectionReport,
  type IntelligenceService,
  type PhotoshopBackend,
  type SetupService,
  type TemplateCandidate,
  type TemplateProfile,
} from '@ne-psd/contracts';
import type { JobRepository } from './job-repository.js';
import { QualificationStore, verifiedFileInRoot } from './qualification-store.js';

export type SetupServiceDependencies = {
  backend: PhotoshopBackend;
  intelligence: IntelligenceService;
  repository: Pick<JobRepository, 'recordQualification'>;
  qualificationRoot: string;
};

const REQUIRED_CHECKS = ['geometry', 'linkage', 'clipping', 'identity', 'variant-1', 'variant-2', 'variant-3', 'source-integrity', 'cleanup'] as const;

async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function evidenceFile(root: string, relativePath: string): string {
  if (!relativePath || isAbsolute(relativePath) || relativePath.includes('\\') || relativePath.split('/').some((part) => part === '' || part === '.' || part === '..')) throw new Error('qualification evidence path is unsafe');
  return verifiedFileInRoot(root, resolve(root, relativePath));
}

function assertCandidateSelectors(candidate: TemplateCandidate, proposal: ConfigurationProposal, inspection: InspectionReport): void {
  const observed = new Map(inspection.candidates.map((item) => [item.candidateId, item]));
  const targets = proposal.targets.map((item) => ({
    target: observed.get(item.targetCandidateId)?.selector,
    reference: observed.get(item.referenceCandidateId)?.selector,
    input: item.inputCandidateId === null ? null : observed.get(item.inputCandidateId)?.selector,
  }));
  const variants = proposal.variants.map((item) => ({ id: item.id, group: observed.get(item.groupCandidateId)?.selector }));
  if (sha256Json(candidate.targets) !== sha256Json(targets) || sha256Json(candidate.variants) !== sha256Json(variants)) throw new Error('qualified candidate selectors do not match observed choices');
  if (candidate.fitMode !== proposal.fitMode || !proposal.output || sha256Json(candidate.output) !== sha256Json(proposal.output)) throw new Error('qualified candidate output differs from selected proposal');
}

export function createSetupService(dependencies: SetupServiceDependencies): SetupService {
  const { backend, intelligence, repository } = dependencies;
  const store = new QualificationStore(dependencies.qualificationRoot);
  return {
    async inspectTemplate(templatePath, signal) {
      const sourcePath = await realpath(templatePath);
      const before = await fileSha256(sourcePath);
      let observed: unknown;
      try { observed = await backend.inspect(sourcePath, signal); }
      finally { if (await fileSha256(sourcePath) !== before) throw new Error('inspection mutated source template'); }
      const inspection = InspectionReportSchema.parse(observed);
      if (inspection.template.sha256 !== before || await fileSha256(sourcePath) !== before) throw new Error('inspection source hash changed or does not match report');
      const paths = [...new Set([...inspection.evidencePaths, ...(inspection.capabilities?.evidencePaths ?? [])])];
      const evidence = await Promise.all(paths.map(async (path) => ({ path, sha256: await fileSha256(evidenceFile(store.root, path)) })));
      store.saveInspection(inspection, sourcePath, evidence);
      return inspection;
    },
    async proposeConfiguration(input, signal) {
      const record = store.getInspection(input.inspectionId);
      if (!record) throw new Error('inspection record is missing');
      const proposal = ConfigurationProposalSchema.parse(await intelligence.propose({ instruction: input.instruction, inspection: record.inspection, modelProfileId: input.modelProfileId }, signal));
      const validated = validateConfigurationProposal(proposal, record.inspection);
      if (!validated.success) throw validated.error;
      store.saveProposal(proposal);
      return proposal;
    },
    async qualifyTemplate(input, signal): Promise<TemplateProfile> {
      const record = store.getInspection(input.inspectionId);
      if (!record) throw new Error('inspection record is missing');
      const inspection = record.inspection;
      for (const entry of record.evidence) if (await fileSha256(evidenceFile(store.root, entry.path)) !== entry.sha256) throw new Error('inspection evidence changed since persistence');
      const proposal = ConfigurationProposalSchema.parse(input.proposal);
      const savedProposal = store.getProposal(input.inspectionId);
      if (!savedProposal || sha256Json(savedProposal) !== sha256Json(proposal)) throw new Error('qualification proposal was not persisted or changed');
      const validated = validateConfigurationProposal(proposal, inspection);
      if (!validated.success) throw validated.error;
      if (proposal.status !== 'proposed' || !proposal.output || inspection.evidenceStatus !== 'liveObserved' || !inspection.capabilities || inspection.unresolvedLinks.length > 0) throw new Error('live inspection and complete resolved proposal are required');
      if (proposal.variants.some((variant) => !inspection.observedVariantStates.some((state) => state.candidateId === variant.groupCandidateId))) throw new Error('selected variant was not observed live');
      const workingTemplatePath = verifiedFileInRoot(store.root, input.workingTemplatePath);
      if (workingTemplatePath === await realpath(record.sourcePath)) throw new Error('qualification cannot mutate the original template');
      const sourceBefore = await fileSha256(record.sourcePath);
      const workingBefore = await fileSha256(workingTemplatePath);
      if (sourceBefore !== inspection.template.sha256 || workingBefore !== sourceBefore) throw new Error('working copy or source differs from inspected template');
      const qualificationId = randomUUID();
      const evidenceDirectory = store.createEvidenceDirectory(qualificationId);
      const request = { schemaVersion: 1 as const, inspection, proposal, workingTemplatePath, evidenceDirectory };
      let qualified: unknown;
      try { qualified = await backend.qualify(request, signal); }
      finally {
        if (await fileSha256(record.sourcePath) !== sourceBefore || await fileSha256(workingTemplatePath) !== workingBefore) throw new Error('qualification mutated source or supplied working template');
      }
      const result = QualificationResultSchema.parse(qualified);
      if (result.status !== 'qualified' || !result.candidate || result.errors.length > 0) throw new Error(`backend qualification blocked: ${result.errors.map((error) => error.code).join(', ')}`);
      const candidate = result.candidate;
      if (candidate.backendId !== inspection.capabilities.backendId || candidate.toolSchemaSha256 !== inspection.capabilities.toolSchemaSha256 || !inspection.capabilities.supportedFitModes.includes(candidate.fitMode)) throw new Error('qualified candidate backend or capability binding differs');
      assertCandidateSelectors(candidate, proposal, inspection);
      const checkIds = new Set(result.checks.map((check) => check.id));
      if (checkIds.size !== result.checks.length || result.checks.some((check) => !check.passed) || REQUIRED_CHECKS.some((id) => !checkIds.has(id))) throw new Error('mandatory qualification checks are missing or failed');
      for (const variant of ['1', '2', '3']) for (const target of proposal.targets) if (!checkIds.has(`sentinel-correspondence-${variant}-${target.targetCandidateId}`)) throw new Error('sentinel correspondence check is missing');
      const evidencePaths = [...new Set([...result.evidencePaths, ...result.checks.map((check) => check.evidencePath)])];
      if (evidencePaths.length === 0 || result.checks.some((check) => !result.evidencePaths.includes(check.evidencePath))) throw new Error('qualification evidence index is incomplete');
      const evidence = await Promise.all(evidencePaths.map(async (path) => {
        const file = evidenceFile(evidenceDirectory, path);
        return { path, sha256: await fileSha256(file) };
      }));
      if (candidate.template.sha256 === inspection.template.sha256 && candidate.template.rootId === inspection.template.rootId && candidate.template.relativePath === inspection.template.relativePath) {
        // An unchanged template remains bound to its inspected source.
      } else {
        if (!candidate.template.rootId.endsWith(':qualification')) throw new Error('prepared template root binding is invalid');
        const preparedPath = evidenceFile(evidenceDirectory, candidate.template.relativePath);
        if (await fileSha256(preparedPath) !== candidate.template.sha256) throw new Error('prepared template digest differs from candidate');
      }
      const profile = TemplateProfileSchema.parse({ ...candidate, qualificationId, profileSha256: sha256Json({ ...candidate, qualificationId }) });
      repository.recordQualification({ qualificationId, profileId: profile.profileId, profileSha256: profile.profileSha256, profile, evidence: { directory: evidenceDirectory, files: evidence, checks: result.checks } });
      return profile;
    },
    async inspectModelProfile(profile, signal) {
      const validated = ModelProfileSchema.parse(profile);
      const result = await intelligence.inspectModelProfile(validated, signal);
      if (typeof result.available !== 'boolean' || !Array.isArray(result.errors)) throw new Error('invalid model inspection result');
      return result;
    },
    async qualifyModelProfile(profile, signal) {
      const validated = ModelProfileSchema.parse(profile);
      return ModelQualificationResultSchema.parse(await intelligence.qualifyModelProfile(validated, signal));
    },
  };
}
