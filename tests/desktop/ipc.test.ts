import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS, createBridgeApi, validateRequest } from '../../apps/desktop/src/main/ipc-schema.js';

describe('desktop IPC boundary', () => {
  it('rejects unknown channels and renderer paths', () => {
    expect(() => validateRequest('shell.exec', {})).toThrow();
    expect(() => validateRequest('job.validate', { spec: { path: '/etc/passwd' } })).toThrow();
  });

  it('exposes only fixed serializable operations and unsubscribe functions', () => {
    const api = createBridgeApi({ invoke: async () => ({ ok: true }), subscribe: () => () => undefined });
    expect(Object.keys(api)).toEqual([...IPC_CHANNELS]);
    expect(typeof api.onEvent(() => undefined)).toBe('function');
  });
});
