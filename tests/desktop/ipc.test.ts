import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBridgeApi, parseResponse, validateEvent, validateRequest, validateResponse } from '../../apps/desktop/src/main/ipc-schema.js';
import validJobSpec from '../fixtures/contracts/job.interactive.json';
import { RootRegistry } from '../../apps/desktop/src/main/paths.js';
import { composeServices } from '../../apps/desktop/src/main/services.js';

describe('desktop IPC boundary', () => {
  it('uses channel-specific strict request and response schemas', () => {
    expect(() => validateRequest('shell.exec', {})).toThrow();
    expect(() => validateRequest('job.pause', { jobId: 'j', extra: true })).toThrow();
    expect(() => validateRequest('setup.inspect', { templatePath: '/tmp/master.psd' })).toThrow();
    expect(() => validateRequest('setup.inspect', { templateHandle: '/tmp/master.psd' })).toThrow();
    expect(() => validateResponse('job.start', { jobId: 'j', extra: true })).toThrow();
    expect(() => validateResponse('job.pause', { ok: true })).toThrow();
    expect(() => validateEvent({ schemaVersion: 1, jobId: 'j' })).toThrow();
  });

  it('uses null on the wire for void methods and void in the typed bridge', async () => {
    for (const channel of ['job.pause', 'job.resume', 'job.cancel', 'job.submitVisualAttestation'] as const) {
      expect(validateResponse(channel, undefined)).toBeNull();
      expect(parseResponse(channel, null)).toBeUndefined();
      expect(() => parseResponse(channel, { ok: true })).toThrow();
    }
    const api = createBridgeApi({ invoke: async () => null, subscribe: () => () => undefined });
    expect(await api.pauseJob({ jobId: 'j' })).toBeUndefined();
    expect(await api.submitVisualAttestation({ requestId: 'r', decision: 'reject', notes: '' })).toBeUndefined();
    expect(Object.keys(api)).not.toContain('invoke');
  });

  it('rejects malformed responses in preload', async () => {
    const api = createBridgeApi({ invoke: async () => ({ jobId: 'j', extra: true }), subscribe: () => () => undefined });
    await expect(api.startJob({ spec: validJobSpec as never })).rejects.toThrow();
  });
});

describe('main-owned root handles', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  it('rejects absolute/traversal/stale roots and a symlink escape before services', () => {
    const parent = mkdtempSync(join(tmpdir(), 'ne-psd-roots-')); dirs.push(parent);
    const root = join(parent, 'root'); const outside = join(parent, 'outside');
    mkdirSync(root); mkdirSync(outside); writeFileSync(join(root, 'master.psd'), 'x'); writeFileSync(join(outside, 'secret'), 'x');
    symlinkSync(outside, join(root, 'linked'));
    const roots = new RootRegistry(); const handle = roots.register('template', root);
    expect(roots.resolve(handle, 'master.psd')).toBe(realpathSync(join(root, 'master.psd')));
    for (const relative of ['/etc/passwd', '../outside/secret', 'linked/secret']) expect(() => roots.resolve(handle, relative)).toThrow();
    expect(() => roots.resolve('template:1', 'master.psd')).toThrow();
    roots.revoke(handle);
    expect(() => roots.resolve(handle, 'master.psd')).toThrow();
  });
});

describe('service composition', () => {
  it('fails closed in production and requires explicit fake development entry', () => {
    expect(() => composeServices('production')).toThrow();
    expect(() => composeServices('development')).toThrow();
    expect(composeServices('development', undefined, true).jobs).toBeDefined();
  });
});
