import { z } from 'zod';
import {
  ConfigurationProposalSchema,
  DomainErrorSchema,
  FileRefSchema,
  InspectionReportSchema,
  ModelProfileSchema,
  SchemaVersionSchema,
  TemplateProfileSchema,
  VariantArtifactSchema,
  VisualReviewRequestSchema,
} from './domain.js';

export const TemplateCandidateSchema = TemplateProfileSchema.omit({ profileSha256: true, qualificationId: true });
export type TemplateCandidate = z.infer<typeof TemplateCandidateSchema>;

export const QualificationRequestSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  inspection: InspectionReportSchema,
  proposal: ConfigurationProposalSchema,
  workingTemplatePath: z.string().min(1),
  evidenceDirectory: z.string().min(1),
}).strict();
export type QualificationRequest = z.infer<typeof QualificationRequestSchema>;

export const QualificationResultSchema = z.object({
  status: z.enum(['qualified', 'blocked']),
  candidate: TemplateCandidateSchema.nullable(),
  checks: z.array(z.object({ id: z.string().min(1), passed: z.boolean(), evidencePath: z.string().min(1) }).strict()),
  evidencePaths: z.array(z.string().min(1)),
  errors: z.array(DomainErrorSchema),
}).strict().superRefine((value, context) => {
  if (value.status === 'qualified' && value.candidate === null) context.addIssue({ code: 'custom', path: ['candidate'], message: 'qualified result requires candidate' });
  if (value.status === 'blocked' && value.candidate !== null) context.addIssue({ code: 'custom', path: ['candidate'], message: 'blocked result cannot include candidate' });
});
export type QualificationResult = z.infer<typeof QualificationResultSchema>;

export const ModelQualificationResultSchema = z.object({
  qualified: z.boolean(),
  evidencePaths: z.array(z.string().min(1)),
  errors: z.array(DomainErrorSchema),
}).strict();

export const ProposalCandidateSchema = z.object({
  inspectionId: z.string().min(1),
  proposal: ConfigurationProposalSchema,
  source: FileRefSchema,
}).strict();

export { ModelProfileSchema, VariantArtifactSchema, VisualReviewRequestSchema };
