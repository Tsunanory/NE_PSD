import { foundationPackage } from '@ne-psd/contracts';

export * from './asset-id.js';
export * from './configuration.js';
export * from './events.js';
export * from './job-repository.js';
export * from './paths.js';
export * from './preflight.js';
export * from './state-machine.js';
export * from './attempt-workspace.js';
export * from './backend-serialization.js';
export * from './cancellation.js';
export * from './recovery.js';
export * from './retry-policy.js';
export * from './runner.js';
export * from './job-service.js';

export function coreFoundation(): ReturnType<typeof foundationPackage> {
  return foundationPackage('@ne-psd/core');
}
