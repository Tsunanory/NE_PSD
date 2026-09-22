import { foundationPackage } from '@ne-psd/contracts';

export function intelligenceFoundation(): ReturnType<typeof foundationPackage> {
  return foundationPackage('@ne-psd/intelligence');
}
export * from './profiles/profile-registry.js';
export * from './profiles/qualification-schema.js';
export * from './profiles/invocation-policy.js';
export * from './review/requirements.js';
export * from './cli/verify-model.js';
