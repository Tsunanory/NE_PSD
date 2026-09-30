import { z } from 'zod';
import { ModelProfileSchema, Sha256Schema } from '@ne-psd/contracts';

export const QualificationStageSchema = z.enum(['artifactVerified', 'runtimeQualified']);
export const ModelQualificationSchema = z.object({
  profile: ModelProfileSchema,
  stage: QualificationStageSchema,
  artifactVerified: z.boolean(),
  runtimeQualified: z.boolean(),
  evidencePaths: z.array(z.string().min(1)),
  errors: z.array(z.object({ code: z.string(), message: z.string() }).strict()),
  artifact: z.object({ sourceUrl: z.string().url(), repository: z.string().min(1), revision: z.string().min(1), architecture: z.string().min(1), parameters: z.string().min(1), license: z.string().min(1), usageTerms: z.string().min(1), files: z.array(z.object({ path: z.string().min(1), bytes: z.number().int().nonnegative(), sha256: Sha256Schema }).strict()).min(1), quantization: z.enum(['Q4_K_M', 'Q6_K', 'Q8_0', 'F16', 'F32']), converterRevision: z.string().nullable(), tokenizer: z.string().min(1), chatTemplate: z.string().min(1), runtimeBuild: z.string().min(1), runtimeSettings: z.record(z.string(), z.string()), shardManifestSha256: Sha256Schema.nullable(), resources: z.object({ os: z.string().min(1), hardware: z.string().min(1), evidencePaths: z.array(z.string().min(1)) }).strict() }).strict().nullable(),
  fixture: z.boolean(),
}).strict();
// A runtime-qualified record is meaningful only when its stages agree and it
// carries the evidence needed to reproduce the claim.
export const QualifiedModelRecordSchema = ModelQualificationSchema.superRefine((value, context) => {
  if (value.runtimeQualified && (!value.artifactVerified || value.stage !== 'runtimeQualified')) context.addIssue({ code: 'custom', path: ['stage'], message: 'runtime qualification requires verified artifact stage' });
  if (value.stage === 'runtimeQualified' && !value.runtimeQualified) context.addIssue({ code: 'custom', path: ['runtimeQualified'], message: 'runtimeQualified stage requires runtimeQualified=true' });
  if (value.profile.provenance.kind === 'local' && value.artifactVerified && value.artifact === null) context.addIssue({ code: 'custom', path: ['artifact'], message: 'local artifact verification requires artifact provenance' });
  if (value.runtimeQualified && value.evidencePaths.length === 0) context.addIssue({ code: 'custom', path: ['evidencePaths'], message: 'runtime qualification requires evidence paths' });
});
export type ModelQualification = z.infer<typeof ModelQualificationSchema>;
