import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { canonicalRelativePath, PathSafetyError, validateWindowsComponent, validateOutputRoot } from './paths.js';

export type PreflightFile = { absolutePath: string; relativePath: string; sha256: string; bytes: number; selectedAtMs: number };
export type PreflightError = { code: string; path: string; message: string };
export type PreflightOptions = { extensions?: readonly string[]; outputRoot?: string; maxPathBytes?: number };

function isImageLike(path: string, bytes: Buffer): boolean {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  if (ext === '.png') return bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0;
  if (ext === '.jpg' || ext === '.jpeg') return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
  if (ext === '.psd' || ext === '.psb') return bytes.length >= 26 && bytes.subarray(0, 4).toString('ascii') === '8BPS';
  return false;
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolvePromise, reject) => { const stream = createReadStream(path); stream.on('data', (chunk) => hash.update(chunk)); stream.on('error', reject); stream.on('end', () => resolvePromise()); });
  return hash.digest('hex');
}

export async function enumerateInputs(inputRoot: string, options: PreflightOptions = {}): Promise<{ files: PreflightFile[]; errors: PreflightError[] }> {
  const root = resolve(inputRoot); const allowed = new Set((options.extensions ?? ['.png', '.jpg', '.jpeg', '.psd', '.psb']).map((ext) => ext.toLowerCase()));
  const files: PreflightFile[] = []; const errors: PreflightError[] = [];
  if (options.outputRoot) try { await validateOutputRoot(root, options.outputRoot); } catch (error) { const e = error as PathSafetyError; errors.push({ code: e.code, path: options.outputRoot, message: e.message }); }
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name); let relativePath: string;
      try { relativePath = canonicalRelativePath(root, absolute); } catch (error) { const e = error as PathSafetyError; errors.push({ code: e.code, path: absolute, message: e.message }); continue; }
      if (entry.isSymbolicLink()) { errors.push({ code: 'SYMLINK_ESCAPE', path: relativePath, message: 'symbolic links are not valid input roots' }); continue; }
      if (entry.isDirectory()) { await walk(absolute); continue; }
      if (!entry.isFile() || !allowed.has(relativePath.slice(relativePath.lastIndexOf('.')).toLowerCase())) continue;
      try {
        validateWindowsComponent(entry.name);
        if (options.outputRoot && resolve(absolute).startsWith(`${resolve(options.outputRoot)}${resolve(options.outputRoot).includes('/') ? '/' : ''}`)) throw new PathSafetyError('OUTPUT_INPUT_COLLISION', 'input enumeration includes output root');
        const bytes = await readFile(absolute); if (bytes.byteLength === 0) throw new PathSafetyError('ZERO_BYTE', 'image is zero bytes');
        if (!isImageLike(relativePath, bytes)) throw new PathSafetyError('CORRUPT_IMAGE', 'image header is not decodable');
        files.push({ absolutePath: absolute, relativePath, sha256: await sha256(absolute), bytes: bytes.byteLength, selectedAtMs: Date.now() });
      } catch (error) { const e = error as PathSafetyError; errors.push({ code: e.code ?? 'INVALID_INPUT', path: relativePath, message: e.message }); }
    }
  }
  await walk(root); files.sort((a, b) => Buffer.from(a.relativePath).compare(Buffer.from(b.relativePath)));
  return { files, errors };
}

export async function validateSourceSnapshot(file: PreflightFile): Promise<void> {
  const info = await lstat(file.absolutePath); const current = await sha256(file.absolutePath);
  if (!info.isFile() || info.size !== file.bytes || current !== file.sha256) { const error = new Error(`source changed after selection: ${file.relativePath}`) as Error & { code: string }; error.code = 'SOURCE_CHANGED'; throw error; }
}
