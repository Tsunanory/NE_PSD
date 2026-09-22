import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS, createBridgeApi, validateRequest } from '../../apps/desktop/src/main/ipc-schema.js';
import { assertSender } from '../../apps/desktop/src/main/ipc.js';
import { packagedRendererUrl } from '../../apps/desktop/src/main/window.js';

describe('desktop IPC boundary', () => {
  it('rejects unknown channels and renderer paths', () => {
    expect(() => validateRequest('shell.exec', {})).toThrow();
    expect(() => validateRequest('job.validate', { spec: { path: '/etc/passwd' } })).toThrow();
  });

  it('exposes only fixed serializable operations and unsubscribe functions', () => {
    const api = createBridgeApi({ invoke: async () => ({ ok: true }), subscribe: () => () => undefined });
    expect(Object.keys(api)).not.toContain('onEvent');
    expect(typeof api.subscribe(() => undefined)).toBe('function');
  });

  it('binds request schemas to channels and accepts the packaged renderer URL', () => {
    expect(() => validateRequest('job.pause', { spec: {} })).toThrow();
    expect(() => validateRequest('setup.inspect', {})).toThrow();
    expect(() => validateRequest('setup.inspect', { templatePath: 'template.psd' })).not.toThrow();
    expect(() => assertSender({ url: packagedRendererUrl() }, 'production')).not.toThrow();
  });
});
