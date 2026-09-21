import { describe, expect, it } from 'vitest';
import { intelligenceFoundation } from '@ne-psd/intelligence';

describe('intelligence foundation package', () => {
  it('consumes the shared contracts package', () => {
    expect(intelligenceFoundation()).toEqual({ packageName: '@ne-psd/intelligence', schemaVersion: 1 });
  });
});
