import { readFile, stat } from 'node:fs/promises';
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
    const path = resolve(root, file.path);
    const info = await stat(path).catch(() => null);
    if (!info || !info.isFile()) return { ok: false, code: 'ARTIFACT_FILE_MISSING', message: file.path };
    const digest = createHash('sha256').update(await readFile(path)).digest('hex');
    if (digest !== file.sha256 || info.size !== file.bytes) return { ok: false, code: 'ARTIFACT_DIGEST_MISMATCH', message: file.path };
  }
  const result = { ok: true, artifactVerified: parsed.data.artifactVerified, runtimeQualified: options.artifactOnly ? false : parsed.data.runtimeQualified, profile: parsed.data.profile.profileId };
  if (options.report) await (await import('node:fs/promises')).writeFile(resolve(options.report), JSON.stringify(result, null, 2));
  return result;
}
