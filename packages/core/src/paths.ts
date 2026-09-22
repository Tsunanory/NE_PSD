import { access, lstat, mkdir, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export class PathSafetyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'PathSafetyError'; this.code = code; }
}

export function validateWindowsComponent(component: string): string {
  if (!component || component === '.' || component === '..') throw new PathSafetyError('UNSAFE_PATH', 'empty or dot path component');
  if (/[\0<>:"/\\|?*]/u.test(component)) throw new PathSafetyError('UNSAFE_PATH', `invalid Windows path component: ${component}`);
  if (/[. ]$/u.test(component)) throw new PathSafetyError('WINDOWS_TRAILING_DOT_SPACE', `Windows path component has a trailing dot or space: ${component}`);
  const stem = component.split('.')[0]!.toUpperCase();
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(stem)) throw new PathSafetyError('WINDOWS_RESERVED_NAME', `Windows reserved name: ${component}`);
  return component;
}

export function canonicalRelativePath(root: string, candidate: string): string {
  const absolute = resolve(root, candidate);
  const rel = relative(resolve(root), absolute);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new PathSafetyError('UNSAFE_PATH', `path escapes root: ${candidate}`);
  const portable = rel.split(sep).join('/');
  for (const component of portable.split('/')) validateWindowsComponent(component);
  if (Buffer.byteLength(portable, 'utf8') > 240) throw new PathSafetyError('PATH_TOO_LONG', `path exceeds Windows-safe length: ${portable}`);
  return portable;
}

export function assertConfinedPath(root: string, candidate: string): string {
  if (!isAbsolute(root) || !isAbsolute(candidate)) throw new PathSafetyError('UNSAFE_PATH', 'root and candidate must be absolute');
  return canonicalRelativePath(root, candidate);
}

export async function assertExistingConfinedPath(root: string, candidate: string): Promise<string> {
  const rel = assertConfinedPath(root, candidate);
  const rootReal = await realpath(root);
  const candidateReal = await realpath(candidate);
  const escaped = relative(rootReal, candidateReal);
  if (escaped === '..' || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) throw new PathSafetyError('SYMLINK_ESCAPE', `path escapes root through a link: ${candidate}`);
  return rel;
}

export async function validateOutputRoot(inputRoot: string, outputRoot: string): Promise<void> {
  const input = resolve(inputRoot);
  const output = resolve(outputRoot);
  const rel = relative(input, output);
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) throw new PathSafetyError('OUTPUT_INSIDE_INPUT', 'output root must not be inside input root');
  await mkdir(output, { recursive: true });
  const info = await stat(output);
  if (!info.isDirectory()) throw new PathSafetyError('OUTPUT_NOT_DIRECTORY', 'output root is not a directory');
  if ((info.mode & 0o222) === 0) throw new PathSafetyError('OUTPUT_NOT_WRITABLE', 'output root is read-only');
  try { await access(output, constants.W_OK); } catch { throw new PathSafetyError('OUTPUT_NOT_WRITABLE', 'output root is not writable'); }
}

export async function assertSourceRootReadOnly(root: string): Promise<void> {
  const info = await lstat(root);
  if ((info.mode & 0o222) !== 0) throw new PathSafetyError('SOURCE_ROOT_WRITABLE', 'renderer source root must not be writable');
}
