import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { readValidatedSource, type PreflightFile } from './preflight.js';

export type AttemptWorkspace = { root: string; sourceCopy?: string; recordedPaths: string[] };

function digest(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }

export async function createAttemptWorkspace(outputRoot: string, jobId: string, assetId: string, attempt: number): Promise<AttemptWorkspace> {
  const root = resolve(outputRoot, '.ne-psd-staging', jobId, assetId, String(attempt));
  await mkdir(root, { recursive: true });
  return { root, recordedPaths: [root] };
}

export async function copyValidatedSource(workspace: AttemptWorkspace, source: PreflightFile): Promise<string> {
  const bytes = await readValidatedSource(source);
  if (bytes.byteLength !== source.bytes || digest(bytes) !== source.sha256) throw Object.assign(new Error('source digest changed during workspace copy'), { code: 'SOURCE_CHANGED' });
  const target = join(workspace.root, 'source' + source.relativePath.slice(source.relativePath.lastIndexOf('.')));
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
    if (path === workspace.root || path.startsWith(`${workspace.root}/`)) await rm(path, { recursive: true, force: true });
  }
}
