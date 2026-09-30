import type { ModelProfile } from '@ne-psd/contracts';
import type { ModelProfileRegistry } from './profile-registry.js';
import type { ModelQualification } from './qualification-schema.js';
import { trialMatches, type CandidateTrialAdmission } from './candidate-trial.js';

export type InvocationInput = { trigger: 'foreground' | 'scheduled'; jobKind: 'planning' | 'review' | 'diagnosis' | 'qualification' | 'digest'; profile: ModelProfile; explicitSelection: boolean; manualAttestation?: boolean; registry?: ModelProfileRegistry; trialAdmission?: CandidateTrialAdmission | undefined; qualification?: ModelQualification; profileQualified?: boolean; schedulerModel?: string; schedulerPin?: string };
export class ModelCapabilityError extends Error { readonly code: string; constructor(code: string, message: string) { super(message); this.name = 'ModelCapabilityError'; this.code = code; } }
export function assertModelCapabilityPreflight(profile: ModelProfile, role: 'planner' | 'reviewer', manualAttestation = false): true {
  if (!profile.capabilities.jsonSchema) throw new ModelCapabilityError('MODEL_CAPABILITY_UNQUALIFIED', 'selected model lacks required structured output capability');
  if (role === 'reviewer' && !manualAttestation && !profile.capabilities.vision)
    throw new ModelCapabilityError('VISION_PROFILE_UNQUALIFIED', 'selected automated reviewer lacks visual input capability');
  return true;
}
export function assertInvocationAllowed(input: InvocationInput): true {
  if (!input.explicitSelection) throw new ModelCapabilityError('MODEL_SELECTION_REQUIRED', 'model selection must be explicit; automatic fallback is forbidden');
  if (input.jobKind === 'planning' || input.jobKind === 'review' || input.jobKind === 'diagnosis')
    assertModelCapabilityPreflight(input.profile, input.jobKind === 'review' ? 'reviewer' : 'planner', input.manualAttestation);
  if (input.trigger === 'scheduled') {
    if (input.jobKind !== 'digest') throw new ModelCapabilityError('SCHEDULED_MODEL_FORBIDDEN', 'local, local-vision and Codex profiles cannot run scheduled jobs');
    if (input.profile.provider !== 'luna' || input.profile.modelId !== 'gpt-5.6-luna' || input.schedulerModel !== 'gpt-5.6-luna' || input.schedulerPin !== 'gpt-5.6-luna') throw new ModelCapabilityError('LUNA_PIN_REQUIRED', 'scheduled digests require gpt-5.6-luna pinned in settings and invocation');
  }
  const admitted = input.registry?.get(input.profile.profileId);
  const trialRole = input.jobKind === 'review' ? 'reviewer' : 'planner';
  const trial = input.trigger === 'foreground' && input.jobKind !== 'digest' && input.trialAdmission?.role === trialRole && admitted && trialMatches(input.trialAdmission, admitted);
  if ((!admitted?.selectable && !trial) || !admitted || JSON.stringify(admitted.profile) !== JSON.stringify(input.profile)) throw new ModelCapabilityError('MODEL_NOT_QUALIFIED', 'selected model profile is unavailable or unqualified');
  if (input.profile.profileId.startsWith('fixture-')) throw new ModelCapabilityError('MODEL_NOT_QUALIFIED', 'fixture profiles are not selectable for production assets');
  if (input.trigger === 'foreground' && input.profile.provider === 'luna') throw new ModelCapabilityError('MODEL_MODE_FORBIDDEN', 'Luna is reserved for scheduled digest policy');
  if (input.jobKind === 'review' && !input.manualAttestation && !input.profile.capabilities.vision) throw new ModelCapabilityError('VISION_REQUIRED', 'automated image review requires qualified image-input capability');
  return true;
}
