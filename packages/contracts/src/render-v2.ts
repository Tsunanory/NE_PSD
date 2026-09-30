import { z } from 'zod';
import {
  AbsolutePathSchema,
  DomainErrorSchema,
  AssetSchema,
  FileRefSchema,
  NonEmptyStringSchema,
  PositiveIntSchema,
  RelativePathSchema,
  RenderEvidenceSchema,
  RenderRequestSchema,
  Sha256Schema,
  TemplateProfileSchema,
} from './domain.js';
import type { PhotoshopBackend } from './services.js';

const AttemptSchema = z.union([z.literal(1), z.literal(2)]);
const StagingDirectoryV2Schema = AbsolutePathSchema.refine((value) => !value.split(/[\\/]/).includes('..'), 'staging directory cannot traverse a parent');
const ProofRefSchema = z.object({ relativePath: RelativePathSchema, sha256: Sha256Schema }).strict();
const ProofIdentityV2Schema = z.object({
  schemaVersion: z.literal(2), jobId: NonEmptyStringSchema, assetId: NonEmptyStringSchema,
  attempt: AttemptSchema, operationId: NonEmptyStringSchema,
}).strict();
const CopyProofEntryV2Schema = z.object({
  original: FileRefSchema, ownedRelativePath: RelativePathSchema, bytes: PositiveIntSchema,
  originalBeforeSha256: Sha256Schema, originalAfterSha256: Sha256Schema,
  copyBeforeSha256: Sha256Schema, copyAfterSha256: Sha256Schema,
}).strict();
const ObservedLinkV2Schema = z.object({
  parentOwnedRelativePath: RelativePathSchema, childOwnedRelativePath: RelativePathSchema,
  identity: NonEmptyStringSchema,
}).strict();
const LinkedCopyProofEntryV2Schema = CopyProofEntryV2Schema.extend({ identity: NonEmptyStringSchema, sourceKind: z.literal('linked') }).strict();
export const OwnedInputProofV2Schema = ProofIdentityV2Schema.extend({
  sourceRootIdentity: Sha256Schema, openedSourceRelativePath: RelativePathSchema,
  source: CopyProofEntryV2Schema, dependencies: z.array(LinkedCopyProofEntryV2Schema),
  observedLinks: z.array(ObservedLinkV2Schema), closureProof: ProofRefSchema,
}).strict();
export type OwnedInputProofV2 = z.infer<typeof OwnedInputProofV2Schema>;
export const TemplateClosureProofV2Schema = ProofIdentityV2Schema.extend({
  template: FileRefSchema, workingTemplateRelativePath: RelativePathSchema,
  closureEntries: z.array(CopyProofEntryV2Schema.extend({ identity: NonEmptyStringSchema, sourceKind: z.enum(['template', 'linked']) }).strict()).min(1),
  observedLinks: z.array(ObservedLinkV2Schema), documentTrace: ProofRefSchema,
}).strict();
export type TemplateClosureProofV2 = z.infer<typeof TemplateClosureProofV2Schema>;
export const ReleaseProofV2Schema = ProofIdentityV2Schema.extend({
  released: z.literal(true), ownerIdentitySha256: Sha256Schema, journalSha256: Sha256Schema,
  ownerSnapshot: ProofRefSchema, journalSnapshot: ProofRefSchema,
}).strict().superRefine((proof, context) => {
  if (proof.ownerIdentitySha256 !== proof.ownerSnapshot.sha256 || proof.journalSha256 !== proof.journalSnapshot.sha256 || proof.ownerSnapshot.relativePath === proof.journalSnapshot.relativePath) {
    context.addIssue({ code: 'custom', path: ['ownerSnapshot'], message: 'release digests must bind distinct saved owner and journal bytes' });
  }
});
export type ReleaseProofV2 = z.infer<typeof ReleaseProofV2Schema>;
const OwnedFileSchema = z.object({ relativePath: RelativePathSchema, sha256: Sha256Schema, bytes: PositiveIntSchema }).strict();
const LinkedDependencySchema = OwnedFileSchema.extend({
  identity: NonEmptyStringSchema,
  original: FileRefSchema,
  sourceKind: z.literal('linked'),
}).strict();

export const OwnedInputV2Schema = z.object({
  scratchDirectory: RelativePathSchema,
  sourceRootIdentity: Sha256Schema,
  source: OwnedFileSchema,
  dependencies: z.array(LinkedDependencySchema),
  closureProof: ProofRefSchema,
}).strict();
export type OwnedInputV2 = z.infer<typeof OwnedInputV2Schema>;

const SourceRootV2Schema = z.object({ rootId: NonEmptyStringSchema, path: StagingDirectoryV2Schema, identity: Sha256Schema }).strict();
export const PrepareRequestV2Schema = z.object({
  schemaVersion: z.literal(2),
  jobId: NonEmptyStringSchema,
  asset: AssetSchema,
  profile: TemplateProfileSchema,
  attempt: AttemptSchema,
  operationId: NonEmptyStringSchema,
  stagingDirectory: StagingDirectoryV2Schema,
  scratchDirectory: RelativePathSchema,
  sourceRoot: SourceRootV2Schema,
}).strict().superRefine((request, context) => {
  if (request.sourceRoot.rootId !== request.asset.source.rootId) context.addIssue({ code: 'custom', path: ['sourceRoot', 'rootId'], message: 'source root must match selected asset root' });
});
export type PrepareRequestV2 = z.infer<typeof PrepareRequestV2Schema>;

const PreparedIdentityV2Shape = {
  schemaVersion: z.literal(2),
  jobId: NonEmptyStringSchema,
  assetId: NonEmptyStringSchema,
  attempt: AttemptSchema,
  operationId: NonEmptyStringSchema,
  stagingDirectory: StagingDirectoryV2Schema,
  profileSha256: Sha256Schema,
  template: FileRefSchema,
  sourceSha256: Sha256Schema,
  sourceRootId: NonEmptyStringSchema,
  sourceRootPath: StagingDirectoryV2Schema,
  sourceRootIdentity: Sha256Schema,
  scratchDirectory: RelativePathSchema,
};
const PreparedSourceV2Schema = z.object({ original: FileRefSchema, bytes: PositiveIntSchema }).strict();
const PreparedDependencyV2Schema = PreparedSourceV2Schema.extend({ identity: NonEmptyStringSchema, sourceKind: z.literal('linked') }).strict();
const PreparedV2Schema = z.object({
  ...PreparedIdentityV2Shape,
  status: z.literal('prepared'),
  source: PreparedSourceV2Schema,
  dependencies: z.array(PreparedDependencyV2Schema),
  closureComplete: z.literal(true),
  closureProof: ProofRefSchema,
}).strict().superRefine((prepared, context) => {
  const identities = new Set<string>();
  const originals = new Set<string>();
  for (const dependency of prepared.dependencies) {
    const original = `${dependency.original.rootId}\0${dependency.original.relativePath}`;
    if (identities.has(dependency.identity) || originals.has(original)) context.addIssue({ code: 'custom', path: ['dependencies'], message: 'prepared dependency identities and originals must be distinct' });
    identities.add(dependency.identity);
    originals.add(original);
  }
});
const BlockedPreparationV2Schema = z.object({
  ...PreparedIdentityV2Shape,
  status: z.literal('blocked'),
  errors: z.array(DomainErrorSchema).min(1),
  evidencePaths: z.array(RelativePathSchema),
}).strict();
export const PreparedInputManifestV2Schema = z.union([PreparedV2Schema, BlockedPreparationV2Schema]);
export type PreparedInputManifestV2 = z.infer<typeof PreparedInputManifestV2Schema>;

const insideScratch = (scratch: string, path: string): boolean => path.startsWith(`${scratch}/`);

export const RenderRequestV2Schema = RenderRequestSchema.omit({ schemaVersion: true }).extend({
  schemaVersion: z.literal(2),
  stagingDirectory: StagingDirectoryV2Schema,
  operationId: NonEmptyStringSchema,
  ownedInput: OwnedInputV2Schema,
}).strict().superRefine((request, context) => {
  const { ownedInput } = request;
  if (ownedInput.source.sha256 !== request.asset.source.sha256 || ownedInput.source.bytes !== request.asset.sourceBytes) {
    context.addIssue({ code: 'custom', path: ['ownedInput', 'source'], message: 'owned source bytes must match the selected asset' });
  }
  const copies = [ownedInput.source, ...ownedInput.dependencies];
  const paths = new Set<string>();
  for (const copy of copies) {
    if (!insideScratch(ownedInput.scratchDirectory, copy.relativePath)) context.addIssue({ code: 'custom', path: ['ownedInput'], message: 'owned copy must be inside scratchDirectory' });
    if (paths.has(copy.relativePath)) context.addIssue({ code: 'custom', path: ['ownedInput'], message: 'owned copy paths must be distinct' });
    paths.add(copy.relativePath);
  }
  const identities = new Set<string>();
  const originals = new Set<string>();
  for (const dependency of ownedInput.dependencies) {
    const original = `${dependency.original.rootId}\0${dependency.original.relativePath}`;
    if (dependency.sha256 !== dependency.original.sha256) context.addIssue({ code: 'custom', path: ['ownedInput', 'dependencies'], message: 'dependency copy digest must match its original before mutation' });
    if (identities.has(dependency.identity) || originals.has(original)) context.addIssue({ code: 'custom', path: ['ownedInput', 'dependencies'], message: 'dependency identities and originals must be distinct' });
    identities.add(dependency.identity);
    originals.add(original);
  }
});
export type RenderRequestV2 = z.infer<typeof RenderRequestV2Schema>;

export const RenderEvidenceV2Schema = RenderEvidenceSchema.omit({ schemaVersion: true }).extend({
  schemaVersion: z.literal(2),
  operationId: NonEmptyStringSchema,
  ownedInputProof: ProofRefSchema,
  templateClosureProof: ProofRefSchema,
  released: z.literal(true),
  releaseProof: ProofRefSchema,
}).strict().superRefine((evidence, context) => {
  if (evidence.ownedInputProof.relativePath === evidence.templateClosureProof.relativePath) context.addIssue({ code: 'custom', path: ['templateClosureProof'], message: 'source and template closure proofs must be separate' });
  if (evidence.releaseProof.relativePath === evidence.ownedInputProof.relativePath || evidence.releaseProof.relativePath === evidence.templateClosureProof.relativePath) context.addIssue({ code: 'custom', path: ['releaseProof'], message: 'release proof must be separate from copy proofs' });
});
export type RenderEvidenceV2 = z.infer<typeof RenderEvidenceV2Schema>;

export const RecoveryRequestV2Schema = z.object({
  schemaVersion: z.literal(2),
  jobId: NonEmptyStringSchema,
  assetId: NonEmptyStringSchema,
  attempt: AttemptSchema,
  operationId: NonEmptyStringSchema,
}).strict();
export type RecoveryRequestV2 = z.infer<typeof RecoveryRequestV2Schema>;

export const RecoveryResultV2Schema = RecoveryRequestV2Schema.extend({
  safe: z.boolean(),
  released: z.boolean(),
  evidencePaths: z.array(RelativePathSchema),
  releaseProof: ProofRefSchema.nullable(),
}).strict().superRefine((result, context) => {
  if (result.safe !== result.released || result.safe !== (result.releaseProof !== null)) {
    context.addIssue({ code: 'custom', path: ['releaseProof'], message: 'safe recovery requires confirmed release and its proof' });
  }
  if (result.releaseProof !== null && !result.evidencePaths.includes(result.releaseProof.relativePath)) {
    context.addIssue({ code: 'custom', path: ['evidencePaths'], message: 'release proof must be included in evidence paths' });
  }
});
export type RecoveryResultV2 = z.infer<typeof RecoveryResultV2Schema>;

function mismatch(message: string) { return { success: false as const, error: new Error(message) }; }
function sameFileRef(left: z.infer<typeof FileRefSchema>, right: z.infer<typeof FileRefSchema>): boolean {
  return left.rootId === right.rootId && left.relativePath === right.relativePath && left.sha256 === right.sha256;
}
function sameProofIdentity(actual: z.infer<typeof ProofIdentityV2Schema>, expected: z.infer<typeof ProofIdentityV2Schema>): boolean {
  return actual.jobId === expected.jobId && actual.assetId === expected.assetId && actual.attempt === expected.attempt && actual.operationId === expected.operationId;
}
function unchangedOriginal(entry: z.infer<typeof CopyProofEntryV2Schema>): boolean {
  return entry.originalBeforeSha256 === entry.original.sha256 && entry.originalAfterSha256 === entry.original.sha256 && entry.copyBeforeSha256 === entry.original.sha256;
}
function linksCoverEntries(links: z.infer<typeof ObservedLinkV2Schema>[], entries: Array<{ identity: string; ownedRelativePath: string }>, parentPaths: Set<string>): boolean {
  const remaining = new Map(entries.map((entry) => [entry.identity, entry.ownedRelativePath]));
  if (remaining.size !== entries.length || links.length !== entries.length) return false;
  for (const link of links) {
    if (!parentPaths.has(link.parentOwnedRelativePath) || remaining.get(link.identity) !== link.childOwnedRelativePath) return false;
    remaining.delete(link.identity);
  }
  return remaining.size === 0;
}

export function validateOwnedInputProofV2(proof: unknown, request: unknown, manifest: unknown) {
  const render = validateRenderRequestV2(request, manifest);
  if (!render.success) return render;
  const parsed = OwnedInputProofV2Schema.safeParse(proof);
  if (!parsed.success) return parsed;
  const actual = parsed.data;
  const expected = render.data;
  const owned = expected.ownedInput;
  if (!sameProofIdentity(actual, { schemaVersion: 2, jobId: expected.jobId, assetId: expected.asset.assetId, attempt: expected.attempt, operationId: expected.operationId }) ||
      actual.sourceRootIdentity !== owned.sourceRootIdentity || actual.openedSourceRelativePath !== owned.source.relativePath ||
      !sameFileRef(actual.source.original, expected.asset.source) || actual.source.ownedRelativePath !== owned.source.relativePath || actual.source.bytes !== owned.source.bytes ||
      !unchangedOriginal(actual.source) || actual.dependencies.length !== owned.dependencies.length ||
      actual.closureProof.relativePath !== owned.closureProof.relativePath || actual.closureProof.sha256 !== owned.closureProof.sha256) return mismatch('owned input proof does not bind the opened source and prepared closure');
  const dependencies = new Map(owned.dependencies.map((entry) => [entry.identity, entry]));
  for (const entry of actual.dependencies) {
    const expectedEntry = dependencies.get(entry.identity);
    if (!expectedEntry || !sameFileRef(entry.original, expectedEntry.original) || entry.ownedRelativePath !== expectedEntry.relativePath || entry.bytes !== expectedEntry.bytes || !unchangedOriginal(entry)) return mismatch('owned input proof dependency differs from prepared inventory');
  }
  const paths = new Set([actual.source.ownedRelativePath, ...actual.dependencies.map((entry) => entry.ownedRelativePath)]);
  if (!linksCoverEntries(actual.observedLinks, actual.dependencies, paths)) return mismatch('observed asset links do not cover prepared dependencies');
  return { success: true as const, data: actual };
}

export function validateTemplateClosureProofV2(proof: unknown, request: unknown) {
  const parsedRequest = RenderRequestV2Schema.safeParse(request);
  if (!parsedRequest.success) return parsedRequest;
  const parsed = TemplateClosureProofV2Schema.safeParse(proof);
  if (!parsed.success) return parsed;
  const actual = parsed.data;
  const expected = parsedRequest.data;
  if (!sameProofIdentity(actual, { schemaVersion: 2, jobId: expected.jobId, assetId: expected.asset.assetId, attempt: expected.attempt, operationId: expected.operationId }) || !sameFileRef(actual.template, expected.profile.template)) return mismatch('template closure proof identity differs from render request');
  const templateEntries = actual.closureEntries.filter((entry) => entry.sourceKind === 'template');
  if (templateEntries.length !== 1 || !sameFileRef(templateEntries[0]!.original, actual.template) || templateEntries[0]!.ownedRelativePath !== actual.workingTemplateRelativePath) return mismatch('template closure proof lacks the opened template copy');
  if (actual.closureEntries.some((entry) => !unchangedOriginal(entry))) return mismatch('template closure proof does not preserve originals');
  const linked = actual.closureEntries.filter((entry) => entry.sourceKind === 'linked');
  const paths = new Set(actual.closureEntries.map((entry) => entry.ownedRelativePath));
  if (paths.size !== actual.closureEntries.length || !linksCoverEntries(actual.observedLinks, linked, paths)) return mismatch('template closure links do not match copied inventory');
  return { success: true as const, data: actual };
}

export function validateReleaseProofV2(proof: unknown, identity: unknown) {
  const expected = ProofIdentityV2Schema.safeParse(identity);
  if (!expected.success) return expected;
  const parsed = ReleaseProofV2Schema.safeParse(proof);
  if (!parsed.success) return parsed;
  if (!sameProofIdentity(parsed.data, expected.data)) return mismatch('release proof operation identity mismatch');
  return { success: true as const, data: parsed.data };
}

export function validatePreparedInputManifestV2(manifest: unknown, request: unknown) {
  const parsedRequest = PrepareRequestV2Schema.safeParse(request);
  if (!parsedRequest.success) return parsedRequest;
  const parsed = PreparedInputManifestV2Schema.safeParse(manifest);
  if (!parsed.success) return parsed;
  const actual = parsed.data;
  const expected = parsedRequest.data;
  if (actual.jobId !== expected.jobId || actual.assetId !== expected.asset.assetId || actual.attempt !== expected.attempt || actual.operationId !== expected.operationId || actual.stagingDirectory !== expected.stagingDirectory || actual.profileSha256 !== expected.profile.profileSha256 || !sameFileRef(actual.template, expected.profile.template) || actual.sourceSha256 !== expected.asset.source.sha256 || actual.sourceRootId !== expected.sourceRoot.rootId || actual.sourceRootPath !== expected.sourceRoot.path || actual.sourceRootIdentity !== expected.sourceRoot.identity || actual.scratchDirectory !== expected.scratchDirectory) return mismatch('prepared inventory does not match the v2 attempt and roots');
  if (actual.status === 'prepared' && (!sameFileRef(actual.source.original, expected.asset.source) || actual.source.bytes !== expected.asset.sourceBytes)) return mismatch('prepared source does not match the selected asset');
  return { success: true as const, data: actual };
}

export function validateRenderRequestV2(request: unknown, manifest: unknown) {
  const parsedRequest = RenderRequestV2Schema.safeParse(request);
  if (!parsedRequest.success) return parsedRequest;
  const parsedManifest = PreparedInputManifestV2Schema.safeParse(manifest);
  if (!parsedManifest.success) return parsedManifest;
  const candidate = parsedRequest.data;
  const prepared = parsedManifest.data;
  if (prepared.status !== 'prepared') return mismatch('blocked preparation cannot authorize a render');
  if (candidate.jobId !== prepared.jobId || candidate.asset.assetId !== prepared.assetId || candidate.attempt !== prepared.attempt || candidate.operationId !== prepared.operationId || candidate.stagingDirectory !== prepared.stagingDirectory || candidate.profile.profileSha256 !== prepared.profileSha256 || !sameFileRef(candidate.profile.template, prepared.template) || candidate.asset.source.sha256 !== prepared.sourceSha256 || candidate.asset.source.rootId !== prepared.sourceRootId || candidate.ownedInput.sourceRootIdentity !== prepared.sourceRootIdentity || candidate.ownedInput.scratchDirectory !== prepared.scratchDirectory || !sameFileRef(candidate.asset.source, prepared.source.original) || candidate.asset.sourceBytes !== prepared.source.bytes) return mismatch('render request does not match prepared inventory');
  const proof = candidate.ownedInput.closureProof;
  if (proof.relativePath !== prepared.closureProof.relativePath || proof.sha256 !== prepared.closureProof.sha256) return mismatch('render request closure proof differs from preparation');
  if (candidate.ownedInput.dependencies.length !== prepared.dependencies.length) return mismatch('render request omits or adds a prepared dependency');
  const manifestDependencies = new Map(prepared.dependencies.map((dependency) => [dependency.identity, dependency]));
  for (const dependency of candidate.ownedInput.dependencies) {
    const original = manifestDependencies.get(dependency.identity);
    if (!original || !sameFileRef(dependency.original, original.original) || dependency.bytes !== original.bytes) return mismatch('render dependency differs from prepared inventory');
  }
  return { success: true as const, data: candidate };
}

export function validateRenderEvidenceV2(evidence: unknown, request: unknown) {
  const parsedRequest = RenderRequestV2Schema.safeParse(request);
  if (!parsedRequest.success) return parsedRequest;
  const parsed = RenderEvidenceV2Schema.safeParse(evidence);
  if (!parsed.success) return parsed;
  const actual = parsed.data;
  const expected = parsedRequest.data;
  if (actual.jobId !== expected.jobId || actual.assetId !== expected.asset.assetId || actual.attempt !== expected.attempt || actual.operationId !== expected.operationId || actual.profileSha256 !== expected.profile.profileSha256 || actual.sourceSha256 !== expected.asset.source.sha256 || actual.toolSchemaSha256 !== expected.profile.toolSchemaSha256) return mismatch('render evidence does not match the v2 attempt');
  return { success: true as const, data: actual };
}

export function validateRecoveryResultV2(result: unknown, request: unknown) {
  const parsedRequest = RecoveryRequestV2Schema.safeParse(request);
  if (!parsedRequest.success) return parsedRequest;
  const parsed = RecoveryResultV2Schema.safeParse(result);
  if (!parsed.success) return parsed;
  const actual = parsed.data;
  const expected = parsedRequest.data;
  if (actual.jobId !== expected.jobId || actual.assetId !== expected.assetId || actual.attempt !== expected.attempt || actual.operationId !== expected.operationId) return mismatch('recovery result does not match the v2 operation');
  return { success: true as const, data: actual };
}

export interface PhotoshopBackendV2 extends Pick<PhotoshopBackend, 'capabilities' | 'inspect' | 'qualify'> {
  prepareOwnedInput(request: PrepareRequestV2, signal: AbortSignal): Promise<PreparedInputManifestV2>;
  render(request: RenderRequestV2, signal: AbortSignal): Promise<RenderEvidenceV2>;
  recover(request: RecoveryRequestV2, signal: AbortSignal): Promise<RecoveryResultV2>;
}
