import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { JobSpec } from '@ne-psd/contracts';

export type RootKind = 'template' | 'assets' | 'output' | 'working';

export class RootRegistry {
  private readonly roots = new Map<string, { path: string; kind: RootKind }>();

  register(kind: RootKind, path: string): string {
    if (!isAbsolute(path) || !existsSync(path)) throw new Error('root must be an existing absolute path');
    const canonical = realpathSync(path);
    if (!statSync(canonical).isDirectory()) throw new Error('root must be a directory');
    const handle = randomUUID();
    this.roots.set(handle, { path: canonical, kind });
    return handle;
  }

  adopt(handle: string, kind: RootKind, path: string): void {
    if (!handle || !isAbsolute(path) || !existsSync(path)) throw new Error('invalid trusted root binding');
    const canonical = realpathSync(path);
    if (!statSync(canonical).isDirectory()) throw new Error('root must be a directory');
    const existing = this.roots.get(handle);
    if (existing && (existing.path !== canonical || existing.kind !== kind)) throw new Error('root handle collision');
    this.roots.set(handle, { path: canonical, kind });
  }

  revoke(handle: string): void { this.roots.delete(handle); }

  root(handle: string, kind: RootKind): string {
    const entry = this.roots.get(handle);
    if (!entry || entry.kind !== kind || !existsSync(entry.path) || realpathSync(entry.path) !== entry.path) throw new Error('stale or invalid root handle');
    return entry.path;
  }

  resolve(handle: string, relativePath: string, kind?: RootKind): string {
    const entry = this.roots.get(handle);
    if (!entry || (kind && entry.kind !== kind)) throw new Error('stale or invalid root handle');
    if (!relativePath || relativePath.includes('\\') || relativePath.includes('\0') || isAbsolute(relativePath) || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('invalid relative path');
    const base = this.root(handle, entry.kind);
    const candidate = resolve(base, relativePath);
    if (!existsSync(candidate)) throw new Error('path does not exist');
    const canonical = realpathSync(candidate);
    if (!canonical.startsWith(`${base}${sep}`) || relative(base, canonical).startsWith('..')) throw new Error('path escapes canonical root');
    return canonical;
  }

  assertJobSpec(spec: JobSpec): void {
    this.resolve(spec.profile.template.rootId, spec.profile.template.relativePath, 'template');
    for (const asset of spec.assets) this.resolve(asset.source.rootId, asset.source.relativePath, 'assets');
    this.root(spec.outputRootId, 'output');
  }
}

export function resolveRootPath(root: string, relativePath: string): string {
  const registry = new RootRegistry();
  return registry.resolve(registry.register('assets', root), relativePath);
}
