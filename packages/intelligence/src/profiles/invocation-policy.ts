import type { ModelProfile } from '@ne-psd/contracts';

export type InvocationInput = { trigger: 'foreground' | 'scheduled'; jobKind: 'planning' | 'review' | 'diagnosis' | 'qualification' | 'digest'; profile: ModelProfile; explicitSelection: boolean; profileQualified?: boolean; schedulerModel?: string; schedulerPin?: string };
export class ModelCapabilityError extends Error { readonly code: string; constructor(code: string, message: string) { super(message); this.name = 'ModelCapabilityError'; this.code = code; } }
export function assertInvocationAllowed(input: InvocationInput): true {
  if (!input.explicitSelection) throw new ModelCapabilityError('MODEL_SELECTION_REQUIRED', 'model selection must be explicit; automatic fallback is forbidden');
  if (input.trigger === 'scheduled') {
    if (input.jobKind !== 'digest') throw new ModelCapabilityError('SCHEDULED_MODEL_FORBIDDEN', 'local, local-vision and Codex profiles cannot run scheduled jobs');
    if (input.profile.provider !== 'luna' || input.profile.modelId !== 'gpt-5.6-luna' || input.schedulerModel !== 'gpt-5.6-luna' || input.schedulerPin !== 'gpt-5.6-luna') throw new ModelCapabilityError('LUNA_PIN_REQUIRED', 'scheduled digests require gpt-5.6-luna pinned in settings and invocation');
  }
  if (input.profileQualified === false) throw new ModelCapabilityError('MODEL_NOT_QUALIFIED', 'selected model profile is unavailable or unqualified');
  if (input.profile.profileId.startsWith('fixture-')) throw new ModelCapabilityError('MODEL_NOT_QUALIFIED', 'fixture profiles are not selectable for production assets');
  if (input.trigger === 'foreground' && input.profile.provider === 'luna') throw new ModelCapabilityError('MODEL_MODE_FORBIDDEN', 'Luna is reserved for scheduled digest policy');
  if (input.jobKind === 'review' && !input.profile.capabilities.vision && input.profile.provider !== 'local-qwen') throw new ModelCapabilityError('VISION_REQUIRED', 'automated image review requires qualified image-input capability');
  return true;
}
