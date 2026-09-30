import { ConfigurationProposalSchema, InspectionReportSchema, type ConfigurationProposal, type FitMode, type InspectionReport } from '@ne-psd/contracts';

export class ProposalValidationError extends Error { readonly code: string; constructor(code: string, message: string) { super(message); this.name = 'ProposalValidationError'; this.code = code; } }
const finalKind = (candidate: InspectionReport['candidates'][number]) => candidate.selector.layerPath.at(-1)?.kind;
const preciseField = /^(?:output\.(?:format|quality|colorSpace|width|height)|capabilities\.(?:backendId|supportedFitModes|toolSchemaSha256|evidencePaths)|qualification\.linkedIsolation|documents\[[0-9]+\]\.(?:parentKey|viaLayer|sourceKind|source)|candidates\[[0-9]+\]\.(?:candidateId|documentKey|selector|bounds|roleHints)|targets\[[0-9]+\]\.(?:targetCandidateId|referenceCandidateId|inputCandidateId)|variants\[[0-2]\]\.groupCandidateId|evidencePaths|unresolvedLinks)$/;
const route = (inspection: InspectionReport, from: string, to: string): boolean => {
  if (from === to) return true;
  const docs = new Map(inspection.documents.map((doc) => [doc.documentKey, doc]));
  const parents = (key: string) => { const out = new Set<string>(); let current: string | null = key; while (current && !out.has(current)) { out.add(current); const doc = docs.get(current); if (!doc || doc.parentKey === null || doc.viaLayer === null) break; current = doc.parentKey; } return out; };
  return parents(from).has(to) || parents(to).has(from);
};
export function validateProposal(inspectionInput: unknown, proposalInput: unknown, instructionEvidence: readonly string[] = [], requestedFitMode?: FitMode): ConfigurationProposal {
  const inspection = InspectionReportSchema.parse(inspectionInput); const proposal = ConfigurationProposalSchema.parse(proposalInput);
  const documents = new Map(inspection.documents.map((document) => [document.documentKey, document]));
  if (documents.size !== inspection.documents.length || inspection.documents.some((document) => (document.parentKey === null) !== (document.viaLayer === null) || (document.parentKey !== null && !documents.has(document.parentKey))) || inspection.candidates.some((candidate) => !documents.has(candidate.documentKey))) throw new ProposalValidationError('PROPOSAL_DOCUMENT_GRAPH_INVALID', 'inspection candidate or document route is not observed');
  if (proposal.inspectionId !== inspection.inspectionId) throw new ProposalValidationError('PROPOSAL_INSPECTION_MISMATCH', 'proposal inspection binding mismatch');
  if (requestedFitMode !== undefined && proposal.fitMode !== requestedFitMode) throw new ProposalValidationError('PROPOSAL_FIT_MUTATION', 'model changed the host-requested fit mode');
  if (proposal.status === 'proposed' && (inspection.unresolvedLinks.length > 0 || inspection.documents.some((doc) => doc.sourceKind === 'unknown' || (doc.sourceKind === 'linked' && doc.source === null)))) throw new ProposalValidationError('PROPOSAL_LINKED_ISOLATION_UNRESOLVED', 'proposed configuration requires resolved linked-document isolation');
  if (proposal.status === 'blocked' && (inspection.unresolvedLinks.length > 0 || inspection.documents.some((doc) => doc.sourceKind === 'unknown' || (doc.sourceKind === 'linked' && doc.source === null))) && !proposal.missingFields.includes('qualification.linkedIsolation')) throw new ProposalValidationError('PROPOSAL_MISSING_LINKED_ISOLATION', 'blocked proposal must identify qualification.linkedIsolation');
  if (proposal.status === 'proposed' && inspection.capabilities === null) throw new ProposalValidationError('PROPOSAL_CAPABILITIES_MISSING', 'proposed configuration requires qualified capabilities');
  if (inspection.capabilities && !inspection.capabilities.supportedFitModes.includes(proposal.fitMode) && !(proposal.status === 'blocked' && proposal.missingFields.includes('capabilities.supportedFitModes'))) throw new ProposalValidationError('PROPOSAL_FIT_UNSUPPORTED', 'requested fit mode is not qualified');
  const candidates = new Map(inspection.candidates.map((candidate) => [candidate.candidateId, candidate])); const used = new Set<string>(); const targetDocuments = new Set<string>();
  for (const target of proposal.targets) {
    const t = candidates.get(target.targetCandidateId); const r = candidates.get(target.referenceCandidateId); const input = target.inputCandidateId ? candidates.get(target.inputCandidateId) : null;
    if (!t || !r || (target.inputCandidateId && !input)) throw new ProposalValidationError('PROPOSAL_UNKNOWN_CANDIDATE', 'proposal references an unknown candidate');
    const mapped = [target.targetCandidateId, target.referenceCandidateId, target.inputCandidateId].filter((id): id is string => id !== null); if (mapped.some((id) => used.has(id))) throw new ProposalValidationError('PROPOSAL_MAPPING_AMBIGUOUS', 'candidate mappings must not repeat'); mapped.forEach((id) => used.add(id));
    if (!t.roleHints.includes('target') || !r.roleHints.includes('reference') || (input && !input.roleHints.includes('input'))) throw new ProposalValidationError('PROPOSAL_ROLE_MISMATCH', 'candidate role is not admitted');
    if (finalKind(t) !== 'smartObject' || !['shape', 'pixel'].includes(finalKind(r) ?? '') || (input && !['smartObject', 'pixel'].includes(finalKind(input) ?? ''))) throw new ProposalValidationError('PROPOSAL_SELECTOR_KIND', 'selector layer kinds do not match target/reference/input roles');
    if (!route(inspection, t.documentKey, r.documentKey) || (input && !route(inspection, t.documentKey, input.documentKey))) throw new ProposalValidationError('PROPOSAL_UNSUPPORTED_LINEAGE', 'target, reference and input have no observed graph route');
    targetDocuments.add(t.documentKey);
  }
  const variantIds = new Set<string>(); for (const variant of proposal.variants) { if (variantIds.has(variant.groupCandidateId)) throw new ProposalValidationError('PROPOSAL_VARIANT_DUPLICATE', 'variant selectors must be distinct'); variantIds.add(variant.groupCandidateId); const candidate = candidates.get(variant.groupCandidateId); if (!candidate || !candidate.roleHints.includes('variant')) throw new ProposalValidationError('PROPOSAL_VARIANT_UNKNOWN', 'variant selector is not an inspected variant'); if (finalKind(candidate) !== 'group' || ![...targetDocuments].every((documentKey) => route(inspection, documentKey, candidate.documentKey))) throw new ProposalValidationError('PROPOSAL_VARIANT_ROUTE', 'variant selector is not connected to an inspected target document'); }
  if (proposal.facts.some((fact) => fact.evidenceRefs.some((ref) => !inspection.evidencePaths.includes(ref) && !instructionEvidence.includes(ref)))) throw new ProposalValidationError('PROPOSAL_EVIDENCE_REFERENCE_UNKNOWN', 'proposal cites evidence outside the supplied request');
  if (proposal.status === 'blocked' && proposal.missingFields.some((field) => !preciseField.test(field))) throw new ProposalValidationError('PROPOSAL_MISSING_FIELD_IMPRECISE', 'blocked proposal must use known precise missing fields');
  return proposal;
}
