import { describe, expect, it } from 'vitest';
import { createOperationCancellation } from '@ne-psd/core';

describe('operation cancellation', () => {
  it('uses one signal and resolves a single deadline', async () => {
    const operation = createOperationCancellation(10);
    await expect(operation.deadline).resolves.toBe('timeout');
    expect(operation.signal.aborted).toBe(true);
    expect(operation.timedOut()).toBe(true);
  });
});
