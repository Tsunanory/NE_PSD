import { ModelProfileSchema, TemplateProfileSchema, validateJobSpec, sha256Json } from '@ne-psd/contracts';
import type { DomainError, JobSpec, ModelProfile } from '@ne-psd/contracts';

export type ConfigurationContext = {
  policySha256?: string;
  backendId?: string;
  toolSchemaSha256?: string;
  modelProfile?: ModelProfile;
  reviewerModelProfile?: ModelProfile;
  qualification?: { qualificationId: string; profileId: string; profileSha256: string };
};
function error(code: string, message: string, category: DomainError['category'] = 'validation'): DomainError { return { code, category, message, retryable: false, evidencePaths: [] }; }

export function validateConfiguration(spec: unknown, context: ConfigurationContext = {}): { valid: boolean; errors: DomainError[]; spec?: JobSpec } {
  const parsed = validateJobSpec(spec);
  if (!parsed.success) return { valid: false, errors: [error('INVALID_CONFIGURATION', parsed.error.message)] };
  const job = parsed.data; const errors: DomainError[] = [];
  if (job.trigger === 'scheduled' && (!context.modelProfile || !context.reviewerModelProfile)) errors.push(error('SCHEDULED_PROFILE_REQUIRED', 'scheduled jobs require both planner and reviewer profiles'));
  if (context.modelProfile) {
    const checked = ModelProfileSchema.safeParse(context.modelProfile);
    if (!checked.success) errors.push(error('INVALID_MODEL_PROFILE', 'planner model profile is invalid'));
    else {
      if (checked.data.profileId !== job.modelProfileId) errors.push(error('MODEL_PROFILE_MISMATCH', 'planner profile is not bound to the job'));
      if (job.trigger === 'scheduled' && checked.data.provider === 'local-qwen') errors.push(error('SCHEDULED_QWEN_FORBIDDEN', 'Qwen jobs cannot be scheduled'));
      if (job.trigger === 'scheduled' && (checked.data.provider !== 'luna' || checked.data.modelId !== 'gpt-5.6-luna' || checked.data.provenance.kind !== 'remote' || checked.data.provenance.provider !== 'luna')) errors.push(error('SCHEDULED_LUNA_ONLY', 'scheduled planner invocations must use remote gpt-5.6-luna'));
    }
  }
  if (context.policySha256 && job.reviewPolicySha256 !== context.policySha256) errors.push(error('POLICY_DIGEST_DRIFT', 'review policy digest does not match configured policy'));
  if (context.backendId && job.profile.backendId !== context.backendId) errors.push(error('BACKEND_DIGEST_DRIFT', 'backend identity does not match the qualified profile'));
  if (context.toolSchemaSha256 && job.profile.toolSchemaSha256 !== context.toolSchemaSha256) errors.push(error('BACKEND_DIGEST_DRIFT', 'backend tool schema digest does not match the qualified profile'));
  if (!job.profile.qualificationId || !job.profile.profileSha256) errors.push(error('TEMPLATE_NOT_QUALIFIED', 'template profile is not sealed by qualification'));
  if (!context.qualification) errors.push(error('QUALIFICATION_REQUIRED', 'template qualification record is required'));
  else if (context.qualification.qualificationId !== job.profile.qualificationId || context.qualification.profileId !== job.profile.profileId || context.qualification.profileSha256 !== job.profile.profileSha256) errors.push(error('QUALIFICATION_MISMATCH', 'template profile does not match persisted qualification'));
  if (job.profile.profileSha256 !== sha256Json(job.profile, { excludeKeys: ['profileSha256'] })) errors.push(error('PROFILE_DIGEST_MISMATCH', 'template profile digest does not match canonical profile content'));
  const reviewer = context.reviewerModelProfile;
  if (reviewer) {
    const checked = ModelProfileSchema.safeParse(reviewer);
    if (!checked.success) errors.push(error('INVALID_REVIEWER_PROFILE', 'reviewer model profile is invalid'));
    else {
      if (checked.data.profileId !== job.reviewerModelProfileId) errors.push(error('REVIEWER_PROFILE_MISMATCH', 'reviewer profile is not bound to the job'));
      if (!checked.data.capabilities.vision) errors.push(error('REVIEWER_NOT_VISION_CAPABLE', 'automated reviewer must expose vision capability'));
      if (job.trigger === 'scheduled' && (checked.data.provider !== 'luna' || checked.data.modelId !== 'gpt-5.6-luna' || checked.data.provenance.kind !== 'remote' || checked.data.provenance.provider !== 'luna')) errors.push(error('SCHEDULED_LUNA_ONLY', 'scheduled reviewer invocations must use remote gpt-5.6-luna'));
    }
  }
  return errors.length ? { valid: false, errors } : { valid: true, errors, spec: job };
}
export const validateJobConfiguration = validateConfiguration;
export const validateJobSpecConfiguration = validateConfiguration;
export function validateTemplateProfile(profile: unknown): { valid: boolean; errors: DomainError[] } {
  const parsed = TemplateProfileSchema.safeParse(profile);
  if (!parsed.success) return { valid: false, errors: [error('INVALID_TEMPLATE_PROFILE', parsed.error.message)] };
  return parsed.data.profileSha256 === sha256Json(parsed.data, { excludeKeys: ['profileSha256'] }) ? { valid: true, errors: [] } : { valid: false, errors: [error('PROFILE_DIGEST_MISMATCH', 'template profile digest does not match canonical profile content')] };
}
