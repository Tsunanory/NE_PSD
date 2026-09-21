import { describe, expect, it } from 'vitest';
import { desktopFoundation } from '@ne-psd/desktop';

describe('desktop foundation package', () => {
  it('consumes contracts through the desktop dependency graph', () => {
    expect(desktopFoundation()).toEqual({
      packageName: '@ne-psd/desktop',
      schemaVersion: 1,
      corePackageName: '@ne-psd/core'
    });
  });
});
