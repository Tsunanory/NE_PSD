import { describe, expect, it } from 'vitest';
import { recoverReadOnly } from '@ne-psd/core';
import type { PhotoshopBackend } from '@ne-psd/contracts';

describe('read-only recovery', () => {
  it('does not treat a dead child as proof of safe Photoshop state', async () => {
    const backend = { recover: async () => { throw new Error('child unavailable'); } } as Pick<PhotoshopBackend, 'recover'>;
    await expect(recoverReadOnly(backend as PhotoshopBackend, 'job', new AbortController().signal)).resolves.toMatchObject({ safe: false, code: 'RECOVERY_FAILED' });
  });
});
