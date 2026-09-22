import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { readValidatedSource, type PreflightFile } from './preflight.js';

export type AttemptWorkspace = { root: string; sourceCopy?: string; recordedPaths: string[] };

function digest(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
function component(value: string, label: string): void { if (!/^[A-Za-z0-9._-]+$/.test(value) || value === '.' || value === '..') throw new Error(`unsafe ${label} path component`); }

export async function createAttemptWorkspace(outputRoot: string, jobId: string, assetId: string, attempt: number): Promise<AttemptWorkspace> {
  component(jobId, 'job'); component(assetId, 'asset'); if (!Number.isInteger(attempt) || attempt < 1 || attempt > 2) throw new Error('unsafe attempt path component');
  const canonicalRoot = await realpath(outputRoot);
  const root = resolve(canonicalRoot, '.ne-psd-staging', jobId, assetId, String(attempt));
  if (root !== resolve(canonicalRoot, '.ne-psd-staging', jobId, assetId, String(attempt)) || !root.startsWith(`${canonicalRoot}/`)) throw new Error('attempt workspace escaped output root');
  for (const path of [resolve(canonicalRoot, '.ne-psd-staging'), resolve(canonicalRoot, '.ne-psd-staging', jobId), resolve(canonicalRoot, '.ne-psd-staging', jobId, assetId)]) {
    try { if ((await lstat(path)).isSymbolicLink()) throw new Error('attempt workspace symlink escape'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  await mkdir(root, { recursive: true });
  return { root, recordedPaths: [root] };
}

export async function copyValidatedSource(workspace: AttemptWorkspace, source: PreflightFile): Promise<string> {
  const bytes = await readValidatedSource(source);
  if (bytes.byteLength !== source.bytes || digest(bytes) !== source.sha256) throw Object.assign(new Error('source digest changed during workspace copy'), { code: 'SOURCE_CHANGED' });
  const target = join(workspace.root, 'source' + source.relativePath.slice(source.relativePath.lastIndexOf('.')));
  if (!target.startsWith(`${workspace.root}/`)) throw new Error('source copy escaped attempt workspace');
  await writeFile(target, bytes, { flag: 'wx' });
  const copied = await readFile(target);
  const info = await stat(target);
  if (info.size !== source.bytes || digest(copied) !== source.sha256) throw Object.assign(new Error('workspace source copy digest mismatch'), { code: 'SOURCE_COPY_MISMATCH' });
  workspace.sourceCopy = target;
  workspace.recordedPaths.push(target);
  return target;
}

export async function cleanupAttemptWorkspace(workspace: AttemptWorkspace): Promise<void> {
  for (const path of [...workspace.recordedPaths].sort((a, b) => b.length - a.length)) {
    if (path === workspace.root || path.startsWith(`${workspace.root}/`)) {
      const parent = resolve(path, '..');
      try { if ((await lstat(parent)).isSymbolicLink()) throw new Error('cleanup parent is a symlink'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await rm(path, { recursive: true, force: true });
    }
  }
}
