import { sha256Json, validateConfigurationProposal } from '@ne-psd/contracts';
import type { ConfigurationProposal, InspectionReport, TemplateProfile } from '@ne-psd/contracts';

export type QualificationOutcome = { status: 'qualified'; profile: TemplateProfile } | { status: 'blocked'; reason: string };
const block = (reason: string): QualificationOutcome => ({ status: 'blocked', reason });

export function qualifyInspection(inspection: InspectionReport, proposal: ConfigurationProposal, workingTemplatePath: string, evidenceDirectory: string): QualificationOutcome {
  if (inspection.evidenceStatus !== 'liveObserved' || inspection.capabilities === null) return block('qualification requires live inspection and capabilities');
  if (!/^\//.test(workingTemplatePath) || !/^\//.test(evidenceDirectory)) return block('qualification paths must be absolute');
  if (/^(.)\1+$/.test(inspection.template.sha256)) return block('template bytes changed or are not verified');
  const duplicateSelectors = new Set<string>();
  for (const candidate of inspection.candidates) { const key = JSON.stringify(candidate.selector); if (duplicateSelectors.has(key)) return block('structurally ambiguous selector'); duplicateSelectors.add(key); }
  const checked = validateConfigurationProposal(proposal, inspection); if (!checked.success) return block(checked.error.message);
  if (!inspection.capabilities.supportedFitModes.includes(proposal.fitMode)) return block(`fit mode ${proposal.fitMode} is unsupported: Этот способ размещения не проверен для выбранного шаблона`);
  if (inspection.documents.some((document) => document.sourceKind === 'linked') && !inspection.evidencePaths.some((path) => path.includes('linked-isolation'))) return block('linked dependency isolation evidence is missing');
  const byId = new Map(inspection.candidates.map((candidate) => [candidate.candidateId, candidate]));
  const target = proposal.targets[0]!; const targetCandidate = byId.get(target.targetCandidateId); const reference = byId.get(target.referenceCandidateId); if (!targetCandidate || !reference) return block('target or reference selector is missing');
  const variants = proposal.variants.map((variant) => byId.get(variant.groupCandidateId)); if (variants.some((variant) => !variant)) return block('all three variant selectors are required');
  const output = proposal.output; if (!output) return block('output policy is required');
  const profileBase = { schemaVersion: 1 as const, profileId: `profile-${inspection.inspectionId}`, template: inspection.template, qualificationId: `qualification-${inspection.inspectionId}`, backendId: inspection.capabilities.backendId, toolSchemaSha256: inspection.capabilities.toolSchemaSha256, fitMode: proposal.fitMode, output, variants: proposal.variants.map((variant, index) => ({ id: variant.id, group: variants[index]!.selector })), targets: [{ target: targetCandidate.selector, reference: reference.selector, input: target.inputCandidateId === null ? null : (byId.get(target.inputCandidateId)?.selector ?? null) }] };
  const profile = { ...profileBase, profileSha256: sha256Json(profileBase) } as TemplateProfile;
  return { status: 'qualified', profile };
}
