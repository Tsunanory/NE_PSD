import { readFileSync } from 'node:fs';
import { isAbsolute, resolve, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RuntimeManifest } from '../../../../packaging/runtime-manifest.mjs';

export type { RuntimeManifest };
export type RuntimePaths = { manifestPath: string; verifierPath: string; bundlePath: string; nodePath: string; mcpPath: string };
const allowedEnv = ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PATH'] as const;
function windowsAbsolute(path: string): boolean { return /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]+\\[^\\]+/.test(path); }
function absolute(path: string): boolean { return isAbsolute(path) || windowsAbsolute(path); }
function hostPath(base: string, child: string): string {
  if (!absolute(base)) throw new Error('resources path must be absolute');
  if (!child || child.includes('\\') || child.split('/').some(part => !part || part === '.' || part === '..') || isAbsolute(child) || win32.isAbsolute(child)) throw new Error('unsafe runtime resource path');
  const windows = windowsAbsolute(base);
  const root = windows ? win32.resolve(base) : resolve(base);
  const resolved = windows ? win32.resolve(root, ...child.split('/')) : resolve(root, ...child.split('/'));
  if (!resolved.startsWith(root + (windows ? '\\' : '/'))) throw new Error('runtime resource escapes bundle');
  return resolved;
}
export function loadRuntimeManifest(resourcesPath: string): RuntimeManifest {
  const manifest = JSON.parse(readFileSync(hostPath(resourcesPath, 'runtime-manifest.json'), 'utf8')) as unknown;
  validateRuntimeManifest(manifest);
  return manifest as RuntimeManifest;
}
export function validateRuntimeManifest(value: unknown): { ready: boolean; missing: string[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('runtime manifest must be an object');
  const m = value as Record<string, unknown>;
  if (Object.keys(m).some(k => !['schemaVersion','platform','status','node','electron','files','packages','fitModes','missing'].includes(k))) throw new Error('runtime manifest has unknown fields');
  if (m.schemaVersion !== 2 || m.platform !== 'win32-x64' || !Array.isArray(m.missing) || !m.missing.every(x => typeof x === 'string' && x.length > 0)) throw new Error('runtime manifest is incomplete');
  if (m.status === 'blocked') {
    if (!m.missing.length) throw new Error('blocked manifest lacks missing evidence');
    return { ready: false, missing: m.missing as string[] };
  }
  if (m.status !== 'ready' || !m.node || !m.electron || !Array.isArray(m.files) || !Array.isArray(m.packages) || !m.fitModes || m.missing.length) throw new Error('ready runtime manifest is incomplete');
  return { ready: true, missing: [] };
}
export function resolvePackagedRuntime(resourcesPath: string, manifest: RuntimeManifest): RuntimePaths {
  validateRuntimeManifest(manifest);
  if (manifest.node.executable !== 'runtime/node.exe' || manifest.node.args.length !== 1 || manifest.node.args[0] !== 'runtime/mcp.cjs') throw new Error('unexpected packaged runtime command');
  const bundlePath = hostPath(resourcesPath, 'bundle');
  return { manifestPath: hostPath(resourcesPath, 'runtime-manifest.json'), verifierPath: hostPath(resourcesPath, 'runtime-manifest.mjs'), bundlePath, nodePath: hostPath(bundlePath, manifest.node.executable), mcpPath: hostPath(bundlePath, manifest.node.args[0]) };
}
export async function verifyPackagedResources(resourcesPath: string): Promise<RuntimePaths> {
  const manifest = loadRuntimeManifest(resourcesPath);
  const paths = resolvePackagedRuntime(resourcesPath, manifest);
  const { verifyBundle } = await import(pathToFileURL(paths.verifierPath).href) as typeof import('../../../../packaging/runtime-manifest.mjs');
  verifyBundle(manifest, paths.bundlePath);
  return paths;
}
export function assertOfflineCommand(args: readonly string[]): void {
  if (args.length !== 2 || !args.every(absolute) || args.some(arg => /:\/\//.test(arg) || /(?:^|[\\/])(?:npm|npx|cmd|powershell)(?:\.exe|\.cmd)?$/i.test(arg))) throw new Error('runtime command must be two absolute offline paths');
}
export function runtimeSpawnOptions(paths: RuntimePaths, sourceEnv: NodeJS.ProcessEnv = process.env): { command: string; args: string[]; options: { shell: false; windowsHide: true; env: NodeJS.ProcessEnv } } {
  const args = [paths.nodePath, paths.mcpPath];
  assertOfflineCommand(args);
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowedEnv) if (sourceEnv[key]) env[key] = sourceEnv[key];
  return { command: paths.nodePath, args: [paths.mcpPath], options: { shell: false, windowsHide: true, env } };
}
