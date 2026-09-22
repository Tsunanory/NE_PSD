import { describe, expect, it } from 'vitest';
import { createOperationCancellation } from '@ne-psd/core';

describe('operation cancellation', () => {
  it('uses one signal and resolves a single deadline', async () => {
    const operation = createOperationCancellation(10);
    await expect(operation.deadline).resolves.toBe('timeout');
    expect(operation.signal.aborted).toBe(true);
    expect(operation.timedOut()).toBe(true);
  });

  it('disposes a cancelled operation without a later timeout', async () => {
    const operation = createOperationCancellation(20);
    operation.cancel('pause');
    operation.dispose();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(operation.timedOut()).toBe(false);
    expect(operation.signal.aborted).toBe(true);
  });
});
