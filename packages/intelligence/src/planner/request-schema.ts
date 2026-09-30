import { z } from 'zod';
import { ConfigurationProposalSchema } from '@ne-psd/contracts';
export const PLANNER_RESPONSE_SCHEMA = z.toJSONSchema(ConfigurationProposalSchema, { target: 'draft-2020-12' });
export const PlannerRequestSchema = z.object({ kind: z.literal('configuration-proposal'), schemaVersion: z.literal(1), instruction: z.string().min(1), inspection: z.unknown(), requestedFitMode: z.enum(['cover', 'contain', 'stretch']).nullable(), instructionEvidence: z.array(z.string()) }).strict();
