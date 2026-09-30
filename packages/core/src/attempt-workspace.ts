import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { FileRef } from '@ne-psd/contracts';
import { filesystemIdentity, type OutputRootBinding } from './job-repository.js';

export type AttemptWorkspace = { root: string; outputRoot: string; outputRootIdentity: string; rootIdentity: string; recordedPaths: string[] };
export type TrustedSourceRoot = OutputRootBinding;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function component(value: string, label: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === '.' || value === '..') throw new Error(`unsafe ${label} path component`);
}
function confined(root: string, relativePath: string): string {
  if (!relativePath || relativePath.includes('\\') || isAbsolute(relativePath) || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('unsafe owned relative path');
  const target = resolve(root, ...relativePath.split('/'));
  const rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('owned path escaped trusted root');
  return target;
}
async function rejectSymlinks(root: string, target: string): Promise<void> {
  const rel = relative(root, target);
  let path = root;
  for (const part of rel.split(sep)) {
    path = join(path, part);
    try { if ((await lstat(path)).isSymbolicLink()) throw new Error('symlink or reparse-point path rejected'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
async function verifyWorkspace(workspace: AttemptWorkspace): Promise<void> {
  if (await realpath(workspace.outputRoot) !== workspace.outputRoot || filesystemIdentity(workspace.outputRoot) !== workspace.outputRootIdentity ||
      await realpath(workspace.root) !== workspace.root || filesystemIdentity(workspace.root) !== workspace.rootIdentity) throw new Error('owned workspace identity changed');
}

export async function createAttemptWorkspace(outputRoot: string, jobId: string, assetId: string, attempt: number): Promise<AttemptWorkspace> {
  component(jobId, 'job'); component(assetId, 'asset');
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 2) throw new Error('unsafe attempt path component');
  const canonicalRoot = await realpath(outputRoot);
  const outputRootIdentity = filesystemIdentity(canonicalRoot);
  const root = resolve(canonicalRoot, '.ne-psd-staging', jobId, assetId, String(attempt));
  if (!root.startsWith(`${canonicalRoot}${sep}`)) throw new Error('attempt workspace escaped output root');
  let path = canonicalRoot;
  for (const part of ['.ne-psd-staging', jobId, assetId]) {
    path = join(path, part);
    await rejectSymlinks(canonicalRoot, path);
    await mkdir(path, { recursive: true });
    if (await realpath(path) !== path) throw new Error('attempt workspace symlink escape');
  }
  try { await mkdir(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('fresh attempt workspace already exists'); throw error; }
  return { root, outputRoot: canonicalRoot, outputRootIdentity, rootIdentity: filesystemIdentity(root), recordedPaths: [root] };
}

export async function copyOwnedFile(workspace: AttemptWorkspace, sourceRoot: TrustedSourceRoot, original: FileRef, bytes: number, targetRelativePath: string): Promise<string> {
  await verifyWorkspace(workspace);
  if (original.rootId !== sourceRoot.rootId || await realpath(sourceRoot.canonicalRoot) !== sourceRoot.canonicalRoot || filesystemIdentity(sourceRoot.canonicalRoot) !== sourceRoot.canonicalRootIdentity) throw new Error('trusted source root identity mismatch');
  const source = confined(sourceRoot.canonicalRoot, original.relativePath);
  await rejectSymlinks(sourceRoot.canonicalRoot, source);
  if (await realpath(source) !== source) throw new Error('source symlink or reparse-point escape');
  const handle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let content: Buffer;
  try {
    if (!(await handle.stat()).isFile()) throw new Error('source is not a regular file');
    content = await handle.readFile();
  } finally { await handle.close(); }
  if (content.length !== bytes || digest(content) !== original.sha256) throw new Error('source digest or byte count changed');
  const target = confined(workspace.root, targetRelativePath);
  await rejectSymlinks(workspace.root, target);
  await mkdir(dirname(target), { recursive: true });
  if (await realpath(dirname(target)) !== dirname(target)) throw new Error('owned target parent symlink escape');
  const targetHandle = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { await targetHandle.writeFile(content); } finally { await targetHandle.close(); }
  workspace.recordedPaths.push(target);
  await verifyWorkspaceFile(workspace, targetRelativePath, original.sha256, bytes);
  return target;
}

export async function verifyWorkspaceFile(workspace: AttemptWorkspace, relativePath: string, sha256: string, bytes?: number): Promise<Buffer> {
  await verifyWorkspace(workspace);
  const target = confined(workspace.root, relativePath);
  await rejectSymlinks(workspace.root, target);
  if (await realpath(target) !== target || !(await stat(target)).isFile()) throw new Error('owned file path changed');
  const content = await readFile(target);
  if (digest(content) !== sha256 || (bytes !== undefined && content.length !== bytes)) throw new Error('owned file digest or byte count mismatch');
  return content;
}

export async function cleanupAttemptWorkspace(workspace: AttemptWorkspace): Promise<void> {
  await verifyWorkspace(workspace);
  if (workspace.recordedPaths[0] !== workspace.root) throw new Error('unrecorded attempt workspace');
  await rm(workspace.root, { recursive: true });
}
