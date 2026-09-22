import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';

function digest(input: string): string { return createHash('sha256').update(input, 'utf8').digest('hex'); }
function readableStem(path: string): string {
  const stem = basename(path, extname(path)).normalize('NFC').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/gu, '').toLowerCase();
  return stem || 'asset';
}

export function assetIdentity(relativePath: string, contentSha256: string): string {
  const canonical = relativePath.normalize('NFC').replaceAll('\\', '/');
  return digest(`${Buffer.from(canonical, 'utf8').toString('hex')}:${contentSha256}`);
}

export function assetId(relativePath: string, contentSha256: string, prefixLength = 12): string {
  const identity = assetIdentity(relativePath, contentSha256);
  return `${readableStem(relativePath)}--${identity.slice(0, Math.max(8, prefixLength))}`;
}

export function assignAssetIds(entries: readonly { relativePath: string; sha256: string }[]): Map<string, string> {
  const identities = entries.map((entry) => ({ ...entry, identity: assetIdentity(entry.relativePath, entry.sha256) }));
  const duplicate = new Set<string>();
  for (const entry of identities) if (duplicate.has(entry.identity)) throw new Error(`duplicate asset identity: ${entry.relativePath}`); else duplicate.add(entry.identity);
  const result = new Map<string, string>();
  for (const entry of [...identities].sort((a, b) => Buffer.from(`${a.relativePath.normalize('NFC')}\0${a.identity}`).compare(Buffer.from(`${b.relativePath.normalize('NFC')}\0${b.identity}`)))) {
    let length = 12;
    let candidate = assetId(entry.relativePath, entry.sha256, length);
    while ([...result.values()].some((value) => value === candidate)) candidate = assetId(entry.relativePath, entry.sha256, length += 4);
    result.set(entry.relativePath, candidate);
  }
  return result;
}
