import { ModelProfileSchema, type DomainError, type ModelProfile } from '@ne-psd/contracts';
import { ModelQualificationSchema, type ModelQualification } from './qualification-schema.js';

export type QualificationAdapter = {
  inspect?: (profile: ModelProfile, signal: AbortSignal) => Promise<{ available: boolean; errors: DomainError[] }>;
  qualify?: (profile: ModelProfile, signal: AbortSignal) => Promise<{ qualified: boolean; evidencePaths: string[]; errors: DomainError[] }>;
  inspectModelProfile?: (profile: ModelProfile, signal: AbortSignal) => Promise<{ available: boolean; errors: DomainError[] }>;
  qualifyModelProfile?: (profile: ModelProfile, signal: AbortSignal) => Promise<{ qualified: boolean; evidencePaths: string[]; errors: DomainError[] }>;
};
export type RegisteredProfile = { profile: ModelProfile; qualification: ModelQualification | null; selectable: boolean };

const error = (code: string, message: string, retryable = false): DomainError => ({ code, category: code === 'CANCELLED' ? 'cancelled' : 'capability', message, retryable, evidencePaths: [] });
function abort(signal: AbortSignal): void { if (signal.aborted) throw new DOMException('The operation was aborted', 'AbortError'); }

export class ModelProfileRegistry {
  private readonly profiles = new Map<string, RegisteredProfile>();
  private static readonly fixtureIds = new Set<string>();
  register(profile: ModelProfile, options: { fixture?: boolean; qualification?: ModelQualification | null } = {}): RegisteredProfile {
    const parsed = ModelProfileSchema.parse(profile);
    const qualification = options.qualification ?? null;
    const result = { profile: parsed, qualification, selectable: Boolean(qualification?.runtimeQualified && !options.fixture && !qualification.fixture) };
    this.profiles.set(parsed.profileId, result);
    if (options.fixture) ModelProfileRegistry.fixtureIds.add(parsed.profileId);
    return result;
  }
  get(profileId: string): RegisteredProfile | undefined { return this.profiles.get(profileId); }
}

async function callInspect(profile: ModelProfile, signal: AbortSignal, adapter?: QualificationAdapter) {
  abort(signal);
  const fn = adapter?.inspect ?? adapter?.inspectModelProfile;
  if (fn) return fn(profile, signal);
  if (profile.provider === 'local-qwen') return { available: false, errors: [error('MODEL_ARTIFACT_UNVERIFIED', 'exact Qwen3.8-27B artifact provenance is unverified by plan')] };
  return { available: profile.provenance.kind === 'remote', errors: profile.provenance.kind === 'remote' ? [] : [error('MODEL_ARTIFACT_UNVERIFIED', 'model artifact provenance is unverified')] };
}

export async function inspectModelProfile(profile: ModelProfile, signal: AbortSignal, adapter?: QualificationAdapter) {
  const parsed = ModelProfileSchema.safeParse(profile);
  if (!parsed.success) return { available: false, errors: [error('INVALID_MODEL_PROFILE', parsed.error.message)] };
  return callInspect(parsed.data, signal, adapter);
}
export async function qualifyModelProfile(profile: ModelProfile, signal: AbortSignal, adapter?: QualificationAdapter) {
  const inspected = await inspectModelProfile(profile, signal, adapter);
  abort(signal);
  if (!inspected.available) return { qualified: false, evidencePaths: [], errors: inspected.errors };
  const fn = adapter?.qualify ?? adapter?.qualifyModelProfile;
  if (fn) return fn(profile, signal);
  return { qualified: false, evidencePaths: [], errors: [error('MODEL_RUNTIME_UNQUALIFIED', 'runtime acceptance corpus is incomplete')] };
}

export { ModelQualificationSchema };
