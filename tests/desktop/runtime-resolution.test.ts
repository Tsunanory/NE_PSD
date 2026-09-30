import { describe, expect, it } from 'vitest';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadRuntimeManifest, validateRuntimeManifest, resolvePackagedRuntime, runtimeSpawnOptions, assertOfflineCommand, verifyPackagedResources } from '../../apps/desktop/src/main/packaged-runtime.js';
import { launchPackagedMcp } from '../../apps/desktop/src/main/runtime.js';

const blocked = JSON.parse(readFileSync(resolve('packaging/runtime-manifest.json'), 'utf8'));
describe('packaged runtime resolution', () => {
  it('loads the shipped manifest from resources, reports blocked evidence, and rejects unknown fields', async () => {
    expect(validateRuntimeManifest(blocked)).toEqual({ ready: false, missing: blocked.missing });
    expect(() => validateRuntimeManifest({ ...blocked, unknown: true })).toThrow();
    expect(() => loadRuntimeManifest('relative/resources')).toThrow();
    await expect(verifyPackagedResources('relative/resources')).rejects.toThrow();
  });
  it('resolves pinned resource paths under Windows Unicode and spaces', () => {
    const runtime = resolvePackagedRuntime('C:\\Users\\Тест\\NE PSD\\resources', blocked);
    expect(runtime.nodePath).toBe('C:\\Users\\Тест\\NE PSD\\resources\\bundle\\runtime\\node.exe');
    expect(runtime.mcpPath).toBe('C:\\Users\\Тест\\NE PSD\\resources\\bundle\\runtime\\mcp.cjs');
    expect(runtime.manifestPath).toBe('C:\\Users\\Тест\\NE PSD\\resources\\runtime-manifest.json');
    expect(runtime.verifierPath).toBe('C:\\Users\\Тест\\NE PSD\\resources\\runtime-manifest.mjs');
    expect(runtimeSpawnOptions(runtime, { SystemRoot: 'C:\\Windows', NODE_OPTIONS: '--require evil', NE_PSD_DEV_FAKE: '1' })).toMatchObject({ command: runtime.nodePath, args: [runtime.mcpPath], options: { shell: false, env: { SystemRoot: 'C:\\Windows' } } });
  });
  it.each(['../escape.exe', '/absolute.exe', 'runtime/..\\evil.exe'])('rejects unsafe manifest path %s', (path) => {
    expect(() => resolvePackagedRuntime('C:\\NE PSD\\resources', { ...blocked, node: { ...blocked.node, executable: path } })).toThrow();
  });
  it('rejects floating commands and URLs', () => {
    expect(() => assertOfflineCommand(['node', 'mcp.cjs'])).toThrow();
    expect(() => assertOfflineCommand(['C:\\NE PSD\\node.exe', 'https://example.com'])).toThrow();
  });
  it('ships the manifest beside the isolated bundle and exposes explicit package scripts', () => {
    const builder = readFileSync(resolve('packaging/electron-builder.yml'), 'utf8');
    const scripts = JSON.parse(readFileSync(resolve('apps/desktop/package.json'), 'utf8')).scripts;
    expect(builder).toMatch(/to: "bundle"/);
    expect(builder).toMatch(/to: "runtime-manifest\.json"/);
    expect(builder).toMatch(/to: "runtime-manifest\.mjs"/);
    expect(scripts['dev:fake']).toContain('NE_PSD_DEV_FAKE=1');
    expect(scripts['dist:win']).toContain('prepare-resources.mjs');
    expect(scripts['verify:bundle']).toContain('verify-bundle.mjs');
  });
  it('loads the packaged verifier and refuses to spawn with blocked evidence', async () => {
    const resources = mkdtempSync(join(tmpdir(), 'NE PSD ресурсы '));
    try {
      mkdirSync(join(resources, 'bundle'));
      writeFileSync(join(resources, 'runtime-manifest.json'), JSON.stringify(blocked));
      copyFileSync(resolve('packaging/runtime-manifest.mjs'), join(resources, 'runtime-manifest.mjs'));
      expect(loadRuntimeManifest(resources).status).toBe('blocked');
      await expect(verifyPackagedResources(resources)).rejects.toThrow(/BLOCKED/);
      await expect(launchPackagedMcp(resources)).rejects.toThrow(/BLOCKED/);
    } finally { rmSync(resources, { recursive: true, force: true }); }
  });
});
