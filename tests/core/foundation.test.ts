import { describe, expect, it } from 'vitest';
import { coreFoundation } from '@ne-psd/core';

describe('core foundation package', () => {
  it('consumes the shared contracts package', () => {
    expect(coreFoundation()).toEqual({ packageName: '@ne-psd/core', schemaVersion: 1 });
  });
});
