import { z } from 'zod';

export const SCHEMA_VERSION = 1 as const;
export const SchemaVersionSchema = z.literal(SCHEMA_VERSION);
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, 'expected lowercase SHA-256 hex');
export const NonEmptyStringSchema = z.string().min(1);
export const PositiveIntSchema = z.number().int().positive().finite();
export const FiniteNumberSchema = z.number().finite();

export const FitModeSchema = z.enum(['cover', 'contain', 'stretch']);
export type FitMode = z.infer<typeof FitModeSchema>;
export const VariantIdSchema = z.enum(['1', '2', '3']);
export type VariantId = z.infer<typeof VariantIdSchema>;

const isSafeRelativePath = (value: string): boolean => {
  if (value.includes('\0') || value.includes('\\') || value.startsWith('/')) return false;
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')) return false;
  return value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
};

export const RelativePathSchema = z.string().min(1).refine(isSafeRelativePath, 'path must be a safe relative POSIX path');
export const AbsolutePathSchema = z.string().min(1).refine((value) => value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value), 'path must be absolute');

export const FileRefSchema = z.object({
  rootId: NonEmptyStringSchema,
  relativePath: RelativePathSchema,
  sha256: Sha256Schema,
}).strict();
export type FileRef = z.infer<typeof FileRefSchema>;

export const RectSchema = z.object({
  left: FiniteNumberSchema,
  top: FiniteNumberSchema,
  right: FiniteNumberSchema,
  bottom: FiniteNumberSchema,
}).strict().refine((value) => value.right > value.left && value.bottom > value.top, 'rectangle must have positive dimensions');
export type Rect = z.infer<typeof RectSchema>;

export const LayerSegmentSchema = z.object({
  name: NonEmptyStringSchema,
  kind: z.enum(['group', 'smartObject', 'pixel', 'shape']),
  fingerprint: NonEmptyStringSchema,
}).strict();
export type LayerSegment = z.infer<typeof LayerSegmentSchema>;

export const LayerSelectorSchema = z.object({
  documentRoute: z.array(z.array(LayerSegmentSchema)),
  layerPath: z.array(LayerSegmentSchema).min(1),
}).strict();
export type LayerSelector = z.infer<typeof LayerSelectorSchema>;

export const VariantSchema = z.object({ id: VariantIdSchema, group: LayerSelectorSchema }).strict();
export type Variant = z.infer<typeof VariantSchema>;

export const OutputSpecSchema = z.object({
  format: z.enum(['jpeg', 'png']),
  quality: z.number().int().min(1).max(100).finite(),
  colorSpace: z.literal('sRGB'),
  width: PositiveIntSchema,
  height: PositiveIntSchema,
}).strict();
export type OutputSpec = z.infer<typeof OutputSpecSchema>;

const exactVariantTuple = <T extends z.ZodType>(schema: T) => z.tuple([schema, schema, schema]).superRefine((items, context) => {
  const ids = items.map((item) => {
    const record = item as { id?: string; variantId?: string };
    return record.id ?? record.variantId;
  });
  if (ids.filter((id): id is string => typeof id === 'string').sort().join(',') !== '1,2,3') context.addIssue({ code: 'custom', message: 'variants must be exactly distinct IDs 1, 2, 3' });
});

export const TemplateProfileSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  profileId: NonEmptyStringSchema,
  template: FileRefSchema,
  profileSha256: Sha256Schema,
  qualificationId: NonEmptyStringSchema,
  backendId: z.enum(['alisaitteke', 'dcc']),
  toolSchemaSha256: Sha256Schema,
  targets: z.array(z.object({ target: LayerSelectorSchema, reference: LayerSelectorSchema, input: LayerSelectorSchema.nullable() }).strict()).min(1),
  fitMode: FitModeSchema,
  output: OutputSpecSchema,
  variants: exactVariantTuple(VariantSchema),
}).strict();
export type TemplateProfile = z.infer<typeof TemplateProfileSchema>;

export const AssetSchema = z.object({
  assetId: NonEmptyStringSchema,
  source: FileRefSchema,
  sourceBytes: PositiveIntSchema,
}).strict();
export type Asset = z.infer<typeof AssetSchema>;

export const JobSpecSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  jobId: NonEmptyStringSchema,
  profile: TemplateProfileSchema,
  assets: z.array(AssetSchema),
  outputRootId: NonEmptyStringSchema,
  modelProfileId: NonEmptyStringSchema,
  reviewerModelProfileId: NonEmptyStringSchema,
  reviewPolicySha256: Sha256Schema,
  trigger: z.enum(['interactive', 'scheduled']),
  maxAttempts: z.literal(2),
}).strict();
export type JobSpec = z.infer<typeof JobSpecSchema>;

export const CapabilityReportSchema = z.object({
  backendId: z.enum(['alisaitteke', 'dcc']),
  version: NonEmptyStringSchema,
  sourceCommit: NonEmptyStringSchema,
  supportedFitModes: z.array(FitModeSchema).min(1),
  toolSchemaSha256: Sha256Schema,
  platform: z.enum(['darwin', 'win32']),
  photoshopVersion: NonEmptyStringSchema,
  evidencePaths: z.array(RelativePathSchema),
}).strict();
export type CapabilityReport = z.infer<typeof CapabilityReportSchema>;

export const RenderRequestSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  jobId: NonEmptyStringSchema,
  asset: AssetSchema,
  profile: TemplateProfileSchema,
  attempt: z.union([z.literal(1), z.literal(2)]),
  stagingDirectory: AbsolutePathSchema,
}).strict();
export type RenderRequest = z.infer<typeof RenderRequestSchema>;

export const VariantArtifactSchema = z.object({
  variantId: VariantIdSchema,
  path: RelativePathSchema,
  sha256: Sha256Schema,
  bytes: PositiveIntSchema,
  colorSpace: z.literal('sRGB'),
  width: PositiveIntSchema,
  height: PositiveIntSchema,
  format: z.enum(['jpeg', 'png']),
}).strict();
export type VariantArtifact = z.infer<typeof VariantArtifactSchema>;

export const GeometryCheckSchema = z.object({
  target: LayerSelectorSchema,
  reference: RectSchema,
  placed: RectSchema,
  fitMode: FitModeSchema,
  clipped: z.boolean(),
  adjacentToReference: z.boolean(),
}).strict();
export const VisibilityCheckSchema = z.object({
  variantId: VariantIdSchema,
  visibleVariantIds: z.array(VariantIdSchema),
}).strict();
export const EvidenceCheckSchema = z.object({
  id: NonEmptyStringSchema,
  passed: z.boolean(),
  evidencePath: RelativePathSchema,
}).strict();

export const RenderEvidenceSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  jobId: NonEmptyStringSchema,
  assetId: NonEmptyStringSchema,
  attempt: z.union([z.literal(1), z.literal(2)]),
  profileSha256: Sha256Schema,
  sourceSha256: Sha256Schema,
  toolSchemaSha256: Sha256Schema,
  geometry: z.array(GeometryCheckSchema),
  visibility: z.array(VisibilityCheckSchema),
  artifacts: exactVariantTuple(VariantArtifactSchema),
  checks: z.array(EvidenceCheckSchema),
  documentTracePath: RelativePathSchema,
  toolTracePath: RelativePathSchema,
}).strict();
export type RenderEvidence = z.infer<typeof RenderEvidenceSchema>;

export const VariantReviewSchema = z.object({
  variantId: VariantIdSchema,
  verdict: z.enum(['pass', 'fail', 'unknown']),
  evidenceRefs: z.array(RelativePathSchema),
  reason: z.string(),
}).strict();
export type VariantReview = z.infer<typeof VariantReviewSchema>;

export const ModelProvenanceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local'), artifactSha256: Sha256Schema, runtimeVersion: NonEmptyStringSchema, chatTemplateSha256: Sha256Schema }).strict(),
  z.object({ kind: z.literal('remote'), provider: z.enum(['codex', 'luna']), modelId: NonEmptyStringSchema, revision: z.string().nullable(), qualificationEvidencePath: RelativePathSchema }).strict(),
]);
export type ModelProvenance = z.infer<typeof ModelProvenanceSchema>;

export const ModelProfileSchema = z.object({
  profileId: NonEmptyStringSchema,
  provider: z.enum(['local-qwen', 'local-vision', 'codex', 'luna']),
  modelId: NonEmptyStringSchema,
  provenance: ModelProvenanceSchema,
  endpoint: NonEmptyStringSchema,
  quantization: z.string().nullable(),
  contextTokens: PositiveIntSchema,
  maxOutputTokens: PositiveIntSchema,
  capabilities: z.object({ jsonSchema: z.boolean(), vision: z.boolean(), tools: z.boolean() }).strict(),
}).strict().superRefine((value, context) => {
  const local = value.provider === 'local-qwen' || value.provider === 'local-vision';
  if (local !== (value.provenance.kind === 'local')) context.addIssue({ code: 'custom', path: ['provenance'], message: 'local providers require local provenance and remote providers require remote provenance' });
});
export type ModelProfile = z.infer<typeof ModelProfileSchema>;

export const DocumentSchema = z.object({
  documentKey: NonEmptyStringSchema,
  parentKey: NonEmptyStringSchema.nullable(),
  viaLayer: LayerSelectorSchema.nullable(),
  sourceKind: z.enum(['root', 'embedded', 'linked', 'unknown']),
  source: FileRefSchema.nullable(),
  width: PositiveIntSchema,
  height: PositiveIntSchema,
  colorMode: NonEmptyStringSchema,
  bitDepth: PositiveIntSchema,
}).strict();
export const InspectionCandidateSchema = z.object({
  candidateId: NonEmptyStringSchema,
  documentKey: NonEmptyStringSchema,
  selector: LayerSelectorSchema,
  bounds: RectSchema.nullable(),
  visible: z.boolean(),
  clipped: z.boolean(),
  belowCandidateId: NonEmptyStringSchema.nullable(),
  roleHints: z.array(z.enum(['target', 'reference', 'input', 'variant'])),
}).strict();

export const InspectionReportSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  inspectionId: NonEmptyStringSchema,
  evidenceStatus: z.enum(['staticCandidate', 'liveObserved']),
  template: FileRefSchema,
  capabilities: CapabilityReportSchema.nullable(),
  documents: z.array(DocumentSchema),
  candidates: z.array(InspectionCandidateSchema).min(1),
  observedVariantStates: z.array(z.object({ candidateId: NonEmptyStringSchema, visible: z.boolean() }).strict()),
  unresolvedLinks: z.array(NonEmptyStringSchema),
  evidencePaths: z.array(RelativePathSchema),
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  for (const candidate of value.candidates) {
    if (ids.has(candidate.candidateId)) context.addIssue({ code: 'custom', path: ['candidates'], message: 'candidate IDs must be unique' });
    ids.add(candidate.candidateId);
  }
  if (value.evidenceStatus === 'liveObserved' && value.capabilities === null) context.addIssue({ code: 'custom', path: ['capabilities'], message: 'live inspection requires capabilities' });
});
export type InspectionReport = z.infer<typeof InspectionReportSchema>;

export const ProposalTargetSchema = z.object({
  targetCandidateId: NonEmptyStringSchema,
  referenceCandidateId: NonEmptyStringSchema,
  inputCandidateId: NonEmptyStringSchema.nullable(),
}).strict();
export const ProposalVariantSchema = z.object({ id: VariantIdSchema, groupCandidateId: NonEmptyStringSchema }).strict();
export const ConfigurationProposalSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  inspectionId: NonEmptyStringSchema,
  status: z.enum(['proposed', 'blocked']),
  targets: z.array(ProposalTargetSchema).min(1),
  variants: exactVariantTuple(ProposalVariantSchema),
  fitMode: FitModeSchema,
  output: OutputSpecSchema.nullable(),
  missingFields: z.array(NonEmptyStringSchema),
  facts: z.array(z.object({ claim: NonEmptyStringSchema, evidenceRefs: z.array(RelativePathSchema) }).strict()),
  explanation: z.string(),
}).strict().superRefine((value, context) => {
  if (value.status === 'proposed' && value.output === null) context.addIssue({ code: 'custom', path: ['output'], message: 'proposed configuration requires output' });
  if (value.status === 'blocked' && value.output !== null) context.addIssue({ code: 'custom', path: ['output'], message: 'blocked configuration cannot contain output' });
  if (value.status === 'blocked' && value.missingFields.length === 0) context.addIssue({ code: 'custom', path: ['missingFields'], message: 'blocked configuration must name missing fields' });
});
export type ConfigurationProposal = z.infer<typeof ConfigurationProposalSchema>;

export const ManifestFileSchema = z.object({
  relativePath: RelativePathSchema,
  sha256: Sha256Schema,
  bytes: PositiveIntSchema,
  role: z.enum(['renderEvidence', 'artifact', 'trace', 'check', 'humanAttestation', 'imageInput']),
}).strict();
export type ManifestFile = z.infer<typeof ManifestFileSchema>;

export const VisionInputSchema = z.object({
  id: NonEmptyStringSchema,
  role: z.enum(['source', 'reference', 'output', 'detail']),
  relativePath: RelativePathSchema,
  sha256: Sha256Schema,
  width: PositiveIntSchema,
  height: PositiveIntSchema,
  variantId: VariantIdSchema.nullable(),
  derivedFromSha256: Sha256Schema,
  crop: RectSchema.nullable(),
}).strict();
export type VisionInput = z.infer<typeof VisionInputSchema>;

export const EvidenceBundleManifestSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  jobId: NonEmptyStringSchema,
  assetId: NonEmptyStringSchema,
  attempt: z.union([z.literal(1), z.literal(2)]),
  files: z.array(ManifestFileSchema),
  visionInputs: z.array(VisionInputSchema),
}).strict().superRefine((value, context) => {
  const paths = value.files.map((file) => file.relativePath);
  if (new Set(paths).size !== paths.length) context.addIssue({ code: 'custom', path: ['files'], message: 'manifest paths must be unique' });
  if (paths.some((path, index) => index > 0 && path.localeCompare(paths[index - 1]!) < 0)) context.addIssue({ code: 'custom', path: ['files'], message: 'manifest paths must be sorted' });
  const indexed = new Set(paths);
  for (const input of value.visionInputs) if (!indexed.has(input.relativePath)) context.addIssue({ code: 'custom', path: ['visionInputs'], message: `vision input is missing from manifest: ${input.relativePath}` });
});
export type EvidenceBundleManifest = z.infer<typeof EvidenceBundleManifestSchema>;

export const ReviewPolicySchema = z.object({
  schemaVersion: SchemaVersionSchema,
  policyId: NonEmptyStringSchema,
  policySha256: Sha256Schema,
  promptSha256: Sha256Schema,
  requirements: z.array(z.object({ id: NonEmptyStringSchema, description: NonEmptyStringSchema, mandatory: z.boolean(), evaluator: z.enum(['deterministic', 'model', 'human']) }).strict()).min(1),
  visualGate: z.enum(['qualifiedVisionReviewer', 'humanPerAsset']),
}).strict();
export type ReviewPolicy = z.infer<typeof ReviewPolicySchema>;

export const ReviewDecisionSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  reviewId: NonEmptyStringSchema,
  jobId: NonEmptyStringSchema,
  assetId: NonEmptyStringSchema,
  attempt: z.union([z.literal(1), z.literal(2)]),
  evidenceSha256: Sha256Schema,
  sessionId: NonEmptyStringSchema,
  promptSha256: Sha256Schema,
  modelId: NonEmptyStringSchema,
  modelProvenance: ModelProvenanceSchema,
  reviewerVersion: NonEmptyStringSchema,
  reviewPolicySha256: Sha256Schema,
  verdict: z.enum(['pass', 'revise', 'blocked']),
  variantChecks: exactVariantTuple(VariantReviewSchema),
  checks: z.array(z.object({ requirementId: NonEmptyStringSchema, result: z.enum(['pass', 'fail', 'unknown']), evidenceRefs: z.array(RelativePathSchema), reason: z.string() }).strict()),
  findings: z.array(z.object({ severity: z.enum(['critical', 'major', 'minor']), code: NonEmptyStringSchema, evidenceRefs: z.array(RelativePathSchema), message: z.string() }).strict()),
}).strict();
export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;

export const VisualReviewRequestSchema = z.object({
  requestId: NonEmptyStringSchema,
  jobId: NonEmptyStringSchema,
  assetId: NonEmptyStringSchema,
  attempt: z.union([z.literal(1), z.literal(2)]),
  preAttestationContentSha256: Sha256Schema,
  profileSha256: Sha256Schema,
  sourceSha256: Sha256Schema,
  toolSchemaSha256: Sha256Schema,
  reviewPolicySha256: Sha256Schema,
  artifacts: exactVariantTuple(VariantArtifactSchema),
  contactSheet: z.object({ relativePath: RelativePathSchema, sha256: Sha256Schema }).strict(),
}).strict();
export type VisualReviewRequest = z.infer<typeof VisualReviewRequestSchema>;

export const AssetStatusSchema = z.enum(['queued', 'rendering', 'reviewing', 'readyToCommit', 'complete', 'failed', 'blocked', 'cancelled']);
export type AssetStatus = z.infer<typeof AssetStatusSchema>;
export const DomainErrorSchema = z.object({ code: NonEmptyStringSchema, category: z.enum(['validation', 'capability', 'transient', 'ambiguousState', 'review', 'cancelled']), message: NonEmptyStringSchema, retryable: z.boolean(), evidencePaths: z.array(NonEmptyStringSchema) }).strict();
export type DomainError = z.infer<typeof DomainErrorSchema>;
export const JobSnapshotSchema = z.object({
  jobId: NonEmptyStringSchema,
  state: z.enum(['ready', 'running', 'pausing', 'paused', 'completed', 'failed', 'blocked', 'cancelled']),
  total: z.number().int().nonnegative().finite(),
  complete: z.number().int().nonnegative().finite(),
  failed: z.number().int().nonnegative().finite(),
  blocked: z.number().int().nonnegative().finite(),
  assets: z.array(z.object({ assetId: NonEmptyStringSchema, status: AssetStatusSchema, attempt: z.number().int().min(0).max(2), error: DomainErrorSchema.nullable() }).strict()),
}).strict();
export type JobSnapshot = z.infer<typeof JobSnapshotSchema>;
export const JobEventSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  jobId: NonEmptyStringSchema,
  sequence: z.number().int().nonnegative().finite(),
  timestamp: z.string().datetime({ offset: true }),
  kind: z.enum(['snapshot', 'assetStatus', 'review', 'error']),
  snapshot: JobSnapshotSchema,
}).strict();
export type JobEvent = z.infer<typeof JobEventSchema>;
