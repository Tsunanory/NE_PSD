import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, mkdtempSync, realpathSync, renameSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import type { Asset } from '@ne-psd/contracts';

const accepted = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const inside = (root: string, path: string): boolean => path === root || path.startsWith(`${root}${sep}`);
export function canonicalExisting(path: string): string {
  if (!existsSync(path) || lstatSync(path).isSymbolicLink()) throw new Error('missing or symlinked selection');
  return realpathSync(path);
}
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
function supportedHeader(ext: string, bytes: Buffer): boolean {
  if (ext === '.png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (ext === '.jpg' || ext === '.jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
}
export type AssetInspection = { assets: Asset[]; rejected: Array<{ name: string; reason: string }> };
export async function inspectAssets(inputDirectory: string, rootId: string): Promise<AssetInspection> {
  const root = canonicalExisting(inputDirectory);
  const assets: Asset[] = []; const rejected: AssetInspection['rejected'] = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const name = entry.name; const path = join(root, name); const ext = extname(name).toLowerCase();
    if (entry.isSymbolicLink()) { rejected.push({ name, reason: 'Symbolic links are not accepted' }); continue; }
    if (!entry.isFile()) { rejected.push({ name, reason: 'Not a regular image file' }); continue; }
    if (!accepted.has(ext)) { rejected.push({ name, reason: `Unsupported file type: ${ext || '(none)'}` }); continue; }
    const info = await stat(path);
    if (info.size === 0 || !Number.isSafeInteger(info.size)) { rejected.push({ name, reason: 'Empty or oversized file' }); continue; }
    const file = await open(path, 'r'); const header = Buffer.alloc(16);
    try { await file.read(header, 0, 16, 0); } finally { await file.close(); }
    if (!supportedHeader(ext, header)) { rejected.push({ name, reason: 'Image signature does not match its format' }); continue; }
    const sha256 = await sha256File(path);
    const assetId = `asset-${createHash('sha256').update(`${name.normalize('NFC')}\0${sha256}`).digest('hex').slice(0, 24)}`;
    assets.push({ assetId, source: { rootId, relativePath: name, sha256 }, sourceBytes: info.size });
  }
  return { assets, rejected };
}
export function validateSetupRoots(templatePath: string, inputDirectory: string, outputDirectory: string): { template: string; input: string; output: string } {
  const template = canonicalExisting(templatePath); const input = canonicalExisting(inputDirectory); const output = canonicalExisting(outputDirectory);
  if (inside(input, output) || inside(output, input) || inside(output, template) || inside(output, dirname(template))) throw new Error('output overlaps a source directory');
  return { template, input, output };
}
export function probeOutputDirectory(outputDirectory: string): number {
  const root = canonicalExisting(outputDirectory);
  const probe = mkdtempSync(join(root, '.ne-psd-probe-'));
  try {
    const first = join(probe, 'write.tmp'); const second = join(probe, 'renamed.tmp');
    writeFileSync(first, 'probe', { flag: 'wx' }); renameSync(first, second);
    const disk = statfsSync(root, { bigint: true });
    const free = disk.bavail * disk.bsize;
    return free > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(free);
  } finally { rmSync(probe, { recursive: true, force: true }); }
}
export function portableReference(root: string, path: string): string {
  const base = canonicalExisting(root); const candidate = canonicalExisting(path);
  if (!inside(base, candidate) || base === candidate) throw new Error('path is outside selected root');
  return relative(base, candidate).split(sep).join('/');
}
export function displayFileName(path: string): string { return basename(path); }
