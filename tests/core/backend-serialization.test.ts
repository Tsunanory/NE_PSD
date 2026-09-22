import { describe, expect, it } from 'vitest';
import { BackendSerialization } from '@ne-psd/core';

describe('backend serialization', () => {
  it('rejects a second Photoshop mutation while the first is unresolved', async () => {
    const serialization = new BackendSerialization();
    let release!: () => void;
    const first = serialization.run(() => new Promise<void>((resolve) => { release = resolve; }));
    await expect(serialization.run(async () => undefined)).rejects.toMatchObject({ code: 'MUTATION_IN_PROGRESS' });
    release();
    await first;
  });
});
