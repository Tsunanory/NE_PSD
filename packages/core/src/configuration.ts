import { ModelProfileSchema, TemplateProfileSchema, validateJobSpec } from '@ne-psd/contracts';
import type { DomainError, JobSpec, ModelProfile } from '@ne-psd/contracts';

export type ConfigurationContext = {
  policySha256?: string;
  backendId?: string;
  toolSchemaSha256?: string;
  modelProfile?: ModelProfile;
  reviewerModelProfile?: ModelProfile;
};

function error(code: string, message: string, category: DomainError['category'] = 'validation'): DomainError { return { code, category, message, retryable: false, evidencePaths: [] }; }

export function validateConfiguration(spec: unknown, context: ConfigurationContext = {}): { valid: boolean; errors: DomainError[]; spec?: JobSpec } {
  const parsed = validateJobSpec(spec);
  if (!parsed.success) return { valid: false, errors: [error('INVALID_CONFIGURATION', parsed.error.message)] };
  const job = parsed.data;
  const errors: DomainError[] = [];
  if (context.modelProfile) {
    const checked = ModelProfileSchema.safeParse(context.modelProfile);
    if (!checked.success) errors.push(error('INVALID_MODEL_PROFILE', 'planner model profile is invalid'));
    else {
      if (checked.data.profileId !== job.modelProfileId) errors.push(error('MODEL_PROFILE_MISMATCH', 'planner profile is not bound to the job'));
      if (job.trigger === 'scheduled' && checked.data.provider === 'local-qwen') errors.push(error('SCHEDULED_QWEN_FORBIDDEN', 'Qwen jobs cannot be scheduled'));
    }
  }
  if (context.policySha256 && job.reviewPolicySha256 !== context.policySha256) errors.push(error('POLICY_DIGEST_DRIFT', 'review policy digest does not match the configured policy'));
  if (context.backendId && job.profile.backendId !== context.backendId) errors.push(error('BACKEND_DIGEST_DRIFT', 'backend identity does not match the qualified profile'));
  if (context.toolSchemaSha256 && job.profile.toolSchemaSha256 !== context.toolSchemaSha256) errors.push(error('BACKEND_DIGEST_DRIFT', 'backend tool schema digest does not match the qualified profile'));
  if (!job.profile.qualificationId || !job.profile.profileSha256) errors.push(error('TEMPLATE_NOT_QUALIFIED', 'template profile is not sealed by qualification'));
  const profile = context.reviewerModelProfile;
  if (profile) {
    const checked = ModelProfileSchema.safeParse(profile);
    if (!checked.success) errors.push(error('INVALID_REVIEWER_PROFILE', 'reviewer model profile is invalid'));
    else if (checked.data.profileId !== job.reviewerModelProfileId) errors.push(error('REVIEWER_PROFILE_MISMATCH', 'reviewer profile is not bound to the job'));
    else if (!checked.data.capabilities.vision) errors.push(error('REVIEWER_NOT_VISION_CAPABLE', 'automated reviewer must expose vision capability'));
  }
  return errors.length ? { valid: false, errors } : { valid: true, errors, spec: job };
}

export const validateJobConfiguration = validateConfiguration;
export const validateJobSpecConfiguration = validateConfiguration;
export function validateTemplateProfile(profile: unknown): { valid: boolean; errors: DomainError[] } {
  const parsed = TemplateProfileSchema.safeParse(profile);
  return parsed.success ? { valid: true, errors: [] } : { valid: false, errors: [error('INVALID_TEMPLATE_PROFILE', parsed.error.message)] };
}
