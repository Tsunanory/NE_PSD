import { readFile, stat, lstat, realpath } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { ModelQualificationSchema } from '../profiles/qualification-schema.js';

export type VerifyModelOptions = { manifest: string; expectedPlatform?: string; artifactOnly?: boolean; report?: string };
export async function verifyModel(options: VerifyModelOptions) {
  if (options.expectedPlatform && options.expectedPlatform !== process.platform) return { ok: false, code: 'PLATFORM_MISMATCH', message: `expected ${options.expectedPlatform}, running on ${process.platform}` };
  const manifestPath = resolve(options.manifest);
  const value = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
  const parsed = ModelQualificationSchema.safeParse(value);
  if (!parsed.success) return { ok: false, code: 'INVALID_QUALIFICATION_MANIFEST', message: parsed.error.message };
  const root = dirname(manifestPath);
  for (const file of parsed.data.artifact?.files ?? []) {
    if (file.path.startsWith('/') || file.path.split('/').includes('..')) return { ok: false, code: 'UNSAFE_ARTIFACT_PATH', message: file.path };
    const path = resolve(root, file.path);
    if (!path.startsWith(`${root}/`)) return { ok: false, code: 'UNSAFE_ARTIFACT_PATH', message: file.path };
    const rootReal = await realpath(root);
    let current = root;
    for (const part of file.path.split('/').slice(0, -1)) { current = resolve(current, part); const link = await lstat(current).catch(() => null); if (link?.isSymbolicLink()) return { ok: false, code: 'SYMLINK_ARTIFACT_PATH', message: file.path }; }
    const info = await stat(path).catch(() => null);
    if (!info || !info.isFile()) return { ok: false, code: 'ARTIFACT_FILE_MISSING', message: file.path };
    if (!(await realpath(path)).startsWith(`${rootReal}/`)) return { ok: false, code: 'ARTIFACT_CONTAINMENT_FAILURE', message: file.path };
    const digest = createHash('sha256').update(await readFile(path)).digest('hex');
    if (digest !== file.sha256 || info.size !== file.bytes) return { ok: false, code: 'ARTIFACT_DIGEST_MISMATCH', message: file.path };
  }
  const artifactVerified = parsed.data.artifact !== null && (parsed.data.artifact.files.length > 0);
  const result = { ok: artifactVerified, artifactVerified, runtimeQualified: !options.artifactOnly && artifactVerified && parsed.data.runtimeQualified && parsed.data.evidencePaths.length > 0, profile: parsed.data.profile.profileId };
  if (options.report) await (await import('node:fs/promises')).writeFile(resolve(options.report), JSON.stringify(result, null, 2));
  return result;
}
