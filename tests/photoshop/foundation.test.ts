import { describe, expect, it } from 'vitest';
import { photoshopFoundation } from '@ne-psd/photoshop';

describe('photoshop foundation package', () => {
  it('consumes the shared contracts package', () => {
    expect(photoshopFoundation()).toEqual({ packageName: '@ne-psd/photoshop', schemaVersion: 1 });
  });
});
