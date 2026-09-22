import { foundationPackage } from '@ne-psd/contracts';

export * from './asset-id.js';
export * from './configuration.js';
export * from './events.js';
export * from './job-repository.js';
export * from './paths.js';
export * from './preflight.js';
export * from './state-machine.js';

export function coreFoundation(): ReturnType<typeof foundationPackage> {
  return foundationPackage('@ne-psd/core');
}
