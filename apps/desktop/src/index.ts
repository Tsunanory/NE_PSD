import { foundationPackage } from '@ne-psd/contracts';
import { coreFoundation } from '@ne-psd/core';

export function desktopFoundation(): {
  packageName: string;
  schemaVersion: 1;
  corePackageName: string;
} {
  return { ...foundationPackage('@ne-psd/desktop'), corePackageName: coreFoundation().packageName };
}
