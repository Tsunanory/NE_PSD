import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import type { Asset } from '@ne-psd/contracts';

const accepted = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const canonical = (path: string) => { if (!existsSync(path) || lstatSync(path).isSymbolicLink()) throw new Error(`path is missing or symlinked: ${path}`); return realpathSync(path); };
const inside = (root: string, path: string) => path === root || path.startsWith(`${root}${sep}`);

export type AssetInspection = { assets: Asset[]; rejected: Array<{ path: string; reason: string }> };

export async function inspectAssets(inputDirectory: string, rootId: string): Promise<AssetInspection> {
  const root = canonical(inputDirectory); const assets: Asset[] = []; const rejected: AssetInspection['rejected'] = [];
  for (const name of readdirSync(root).sort((a, b) => a.localeCompare(b))) {
    const path = join(root, name); if (!lstatSync(path).isFile()) continue;
    if (!accepted.has(extname(name).toLowerCase())) { rejected.push({ path, reason: `Unsupported file type: ${extname(name) || '(none)'}` }); continue; }
    const bytes = readFileSync(path); const sha256 = digest(bytes); const assetId = `asset-${digest(Buffer.from(`${name}\0${sha256}`)).slice(0, 24)}`;
    assets.push({ assetId, source: { rootId, relativePath: name, sha256 }, sourceBytes: bytes.byteLength });
  }
  return { assets, rejected };
}

export function validateSetupRoots(templatePath: string, inputDirectory: string, outputDirectory: string): { template: string; input: string; output: string } {
  const template = canonical(templatePath); const input = canonical(inputDirectory); const output = canonical(outputDirectory);
  if (inside(input, template) || inside(output, template) || inside(input, output) || inside(output, input)) throw new Error('template, input and output roots must not overlap');
  return { template, input, output };
}

export function probeOutputDirectory(outputDirectory: string): void {
  const root = canonical(outputDirectory); const probe = mkdtempSync(join(root, '.ne-psd-probe-')); const first = join(probe, 'write.tmp'); const second = join(probe, 'renamed.tmp');
  try { writeFileSync(first, 'probe', { flag: 'wx' }); renameSync(first, second); } finally { rmSync(probe, { recursive: true, force: true }); }
}

export function portableReference(root: string, path: string): string { const canonicalRoot = canonical(root); const canonicalPath = resolve(path); if (!inside(canonicalRoot, canonicalPath)) throw new Error('path is outside selected root'); return relative(canonicalRoot, canonicalPath).split(sep).join('/'); }
export function displayFileName(path: string): string { return basename(path); }
