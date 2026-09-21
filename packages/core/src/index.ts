import { foundationPackage } from '@ne-psd/contracts';

export function coreFoundation(): ReturnType<typeof foundationPackage> {
  return foundationPackage('@ne-psd/core');
}
