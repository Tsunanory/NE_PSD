import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createQualificationRuntime } from '../../packages/intelligence/dist/transport/qualified-runtime-bridge.js';

const previous = process.env.NE_PSD_QUALIFIED_RUNTIME_BRIDGE_MODULE;
const roots: string[] = [];
afterEach(async () => { if (previous === undefined) delete process.env.NE_PSD_QUALIFIED_RUNTIME_BRIDGE_MODULE; else process.env.NE_PSD_QUALIFIED_RUNTIME_BRIDGE_MODULE = previous; await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('operator-injected qualification runtime', () => {
  it('fails closed without an explicit installed module', async () => {
    delete process.env.NE_PSD_QUALIFIED_RUNTIME_BRIDGE_MODULE;
    await expect(createQualificationRuntime({} as never)).rejects.toThrow(/NOT_CONFIGURED/);
  });
  it('loads only an explicit live runtime with probe and measurement methods', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ne-psd-runtime-module-')); roots.push(root);
    const path = join(await realpath(root), 'bridge.mjs');
    await writeFile(path, "export async function createQualificationRuntime() { return { provenance: 'live', deadlineMs: 1000, locks: {}, probe: async () => ({}), transport: { invoke: async () => ({}) }, counterFor: () => ({}), beginMeasurement: async () => {}, measure: async () => [] }; }\n");
    process.env.NE_PSD_QUALIFIED_RUNTIME_BRIDGE_MODULE = path;
    expect((await createQualificationRuntime({} as never)).provenance).toBe('live');
  });
  it('rejects incomplete injected runtime surface', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ne-psd-runtime-module-')); roots.push(root);
    const path = join(await realpath(root), 'bridge.mjs');
    await writeFile(path, "export async function createQualificationRuntime() { return { provenance: 'live', deadlineMs: 1000, locks: {} }; }\n");
    process.env.NE_PSD_QUALIFIED_RUNTIME_BRIDGE_MODULE = path;
    await expect(createQualificationRuntime({} as never)).rejects.toThrow(/INVALID/);
  });
});
