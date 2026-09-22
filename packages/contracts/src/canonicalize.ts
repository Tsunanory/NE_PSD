import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import canonicalizeModule from 'canonicalize';
import { ManifestFileSchema, type ManifestFile } from './domain.js';

export type CanonicalizeOptions = { excludeKeys?: readonly string[] };

export function canonicalize(value: unknown, options: CanonicalizeOptions = {}): string {
  let input = value;
  if (options.excludeKeys !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const excluded = new Set(options.excludeKeys);
    input = Object.fromEntries(Object.entries(value).filter(([key]) => !excluded.has(key)));
  }
  const result = (canonicalizeModule as unknown as (input: unknown) => string | undefined)(input);
  if (result === undefined) throw new TypeError('value is not JSON-compatible');
  return result;
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha256Text(text: string): string {
  return sha256Bytes(Buffer.from(text, 'utf8'));
}

export function sha256Json(value: unknown, options: CanonicalizeOptions = {}): string {
  return sha256Text(canonicalize(value, options));
}

export async function digestJson(value: unknown, options: CanonicalizeOptions = {}): Promise<string> {
  return sha256Json(value, options);
}

export async function digestFile(path: string): Promise<string> {
  return sha256Bytes(await readFile(path));
}

export function validateManifestEntries(entries: readonly ManifestFile[]) {
  const parsed = entries.map((entry) => ManifestFileSchema.safeParse(entry));
  if (parsed.some((result) => !result.success)) return { success: false as const, error: new Error('manifest entry is invalid') };
  const normalized = entries.map((entry) => ({ ...entry }));
  const paths = normalized.map((entry) => entry.relativePath);
  if (new Set(paths).size !== paths.length) return { success: false as const, error: new Error('manifest entries must be unique') };
  if (paths.some((path, index) => index > 0 && path.localeCompare(paths[index - 1]!) < 0)) return { success: false as const, error: new Error('manifest entries must be sorted') };
  return { success: true as const, data: normalized };
}

export async function verifyManifestFiles(bundleRoot: string, entries: readonly ManifestFile[]) {
  const valid = validateManifestEntries(entries);
  if (!valid.success) return valid;
  const root = await realpath(bundleRoot);
  for (const entry of valid.data) {
    const candidate = join(root, entry.relativePath);
    const resolved = await realpath(candidate).catch(() => null);
    if (resolved === null || (resolved !== root && !resolved.startsWith(`${root}${sep}`))) return { success: false as const, error: new Error(`manifest path escapes bundle: ${entry.relativePath}`) };
    const info = await lstat(candidate);
    if (info.isSymbolicLink()) return { success: false as const, error: new Error(`symlink is not allowed: ${entry.relativePath}`) };
    const bytes = await readFile(candidate);
    if (bytes.byteLength !== entry.bytes || sha256Bytes(bytes) !== entry.sha256) return { success: false as const, error: new Error(`manifest bytes changed: ${entry.relativePath}`) };
  }
  return { success: true as const, data: valid.data };
}

export function bundleDigest(manifest: unknown): string {
  return sha256Json(manifest, { excludeKeys: ['evidenceSha256', 'manifestSha256'] });
}

export function digestWithoutSelfHash(value: unknown, selfHashField: string): string {
  return sha256Json(value, { excludeKeys: [selfHashField] });
}

export function validateManifestCompleteness(manifest: { files: readonly ManifestFile[]; visionInputs: readonly { relativePath: string }[] }, referencedPaths: readonly string[] = []): { success: true } | { success: false; error: Error } {
  const indexed = new Set(manifest.files.map((file) => file.relativePath));
  const required = [...manifest.visionInputs.map((input) => input.relativePath), ...referencedPaths];
  const missing = required.find((path) => !indexed.has(path));
  return missing === undefined ? { success: true } : { success: false, error: new Error(`referenced file missing from manifest: ${missing}`) };
}

/** Lexical-only check. Use verifyManifestFiles for security-sensitive filesystem validation. */
export function isLexicallySafeBundlePath(bundleRoot: string, candidatePath: string): boolean {
  if (candidatePath.includes('\0') || isAbsolute(candidatePath) || /^[A-Za-z]:[\\/]/.test(candidatePath) || candidatePath.startsWith('\\\\')) return false;
  const resolved = relative(bundleRoot, join(bundleRoot, candidatePath));
  return resolved !== '..' && !resolved.startsWith(`..${sep}`) && !isAbsolute(resolved);
}

/** @deprecated Use isLexicallySafeBundlePath; this helper never verifies filesystem containment. */
export const isSafeBundlePath = isLexicallySafeBundlePath;
