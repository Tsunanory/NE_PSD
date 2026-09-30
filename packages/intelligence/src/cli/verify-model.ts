import { readFile, stat, lstat, realpath } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute, win32, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { ModelQualificationSchema } from '../profiles/qualification-schema.js';

export type VerifyModelOptions = { manifest: string; expectedPlatform?: string; artifactOnly?: boolean; report?: string };
export const validateRelativePath = (value: string) => value.length > 0 && !value.includes('\\') && !isAbsolute(value) && !win32.isAbsolute(value) && !/^[A-Za-z]:/.test(value) && !value.split('/').some((part) => part === '' || part === '.' || part === '..');
export const isContainedPath = (root: string, target: string) => { const rel = relative(root, target); return rel !== '' && !isAbsolute(rel) && !win32.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith('../') && !rel.startsWith('..\\'); };
export async function verifyModel(options: VerifyModelOptions) {
  if (options.expectedPlatform && options.expectedPlatform !== process.platform) return { ok: false, code: 'PLATFORM_MISMATCH', message: `expected ${options.expectedPlatform}, running on ${process.platform}` };
  const manifestPath = resolve(options.manifest);
  const value = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
  const parsed = ModelQualificationSchema.safeParse(value);
  if (!parsed.success) return { ok: false, code: 'INVALID_QUALIFICATION_MANIFEST', message: parsed.error.message };
  const root = dirname(manifestPath);
  for (const file of parsed.data.artifact?.files ?? []) {
    if (!validateRelativePath(file.path)) return { ok: false, code: 'UNSAFE_ARTIFACT_PATH', message: file.path };
    const path = resolve(root, file.path);
    if (!isContainedPath(root, path)) return { ok: false, code: 'UNSAFE_ARTIFACT_PATH', message: file.path };
    const rootReal = await realpath(root);
    let current = root;
    for (const part of file.path.split('/').slice(0, -1)) { current = resolve(current, part); const link = await lstat(current).catch(() => null); if (link?.isSymbolicLink()) return { ok: false, code: 'SYMLINK_ARTIFACT_PATH', message: file.path }; }
    const entry = await lstat(path).catch(() => null);
    if (entry?.isSymbolicLink()) return { ok: false, code: 'SYMLINK_ARTIFACT_PATH', message: file.path };
    const info = await stat(path).catch(() => null);
    if (!info || !info.isFile()) return { ok: false, code: 'ARTIFACT_FILE_MISSING', message: file.path };
    if (!isContainedPath(rootReal, await realpath(path))) return { ok: false, code: 'ARTIFACT_CONTAINMENT_FAILURE', message: file.path };
    const digest = createHash('sha256').update(await readFile(path)).digest('hex');
    if (digest !== file.sha256 || info.size !== file.bytes) return { ok: false, code: 'ARTIFACT_DIGEST_MISMATCH', message: file.path };
  }
  const evidencePaths = [...parsed.data.evidencePaths, ...(parsed.data.artifact?.resources.evidencePaths ?? [])];
  if (!options.artifactOnly) for (const evidencePath of evidencePaths) {
    if (!validateRelativePath(evidencePath)) return { ok: false, code: 'UNSAFE_EVIDENCE_PATH', message: evidencePath };
    const evidence = resolve(root, evidencePath);
    const entry = await lstat(evidence).catch(() => null);
    if (!entry) return { ok: false, code: 'EVIDENCE_FILE_MISSING', message: evidencePath };
    if (entry.isSymbolicLink() || !(entry as { isFile?: () => boolean }).isFile?.() || !isContainedPath(await realpath(root), await realpath(evidence))) return { ok: false, code: 'EVIDENCE_CONTAINMENT_FAILURE', message: evidencePath };
  }
  const artifactVerified = parsed.data.artifact !== null && (parsed.data.artifact.files.length > 0);
  const result = { ok: artifactVerified, artifactVerified, runtimeQualified: !options.artifactOnly && artifactVerified && parsed.data.runtimeQualified && parsed.data.evidencePaths.length > 0, profile: parsed.data.profile.profileId };
  if (options.report) await (await import('node:fs/promises')).writeFile(resolve(options.report), JSON.stringify(result, null, 2));
  return result;
}
