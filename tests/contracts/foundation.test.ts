import { describe, expect, it } from 'vitest';
import { FOUNDATION_SCHEMA_VERSION, foundationPackage } from '@ne-psd/contracts';

describe('contracts foundation package', () => {
  it('exports a versioned package probe for downstream consumers', () => {
    expect(foundationPackage('@ne-psd/contracts')).toEqual({
      packageName: '@ne-psd/contracts',
      schemaVersion: FOUNDATION_SCHEMA_VERSION
    });
  });
});
