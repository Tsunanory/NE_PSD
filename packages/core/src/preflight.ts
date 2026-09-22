import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assertExistingConfinedPath, assertSourceRootReadOnly, canonicalRelativePath, PathSafetyError, validateOutputPathBudget, validateWindowsComponent, validateOutputRoot } from './paths.js';

export type PreflightFile = { absolutePath: string; relativePath: string; sha256: string; bytes: number; selectedAtMs: number };
export type PreflightError = { code: string; path: string; message: string };
export type SourceRootPolicy = (root: string) => Promise<void> | void;
export type ByteValidatorContext = { bytes: Buffer; path: string };
export type PreflightOptions = { extensions?: readonly string[]; outputRoot?: string; maxPathBytes?: number; sourceRootPolicy?: SourceRootPolicy; rasterValidator?: (context: ByteValidatorContext) => Promise<void>; psdValidator?: (context: ByteValidatorContext) => Promise<boolean> };

function sha256Bytes(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
async function decodeRaster(context: ByteValidatorContext): Promise<void> { const sharp = (await import('sharp')).default; try { await sharp(context.bytes).toBuffer(); } catch { throw new PathSafetyError('CORRUPT_IMAGE', 'Sharp could not decode the raster image'); } }

export async function enumerateInputs(inputRoot: string, options: PreflightOptions = {}): Promise<{ files: PreflightFile[]; errors: PreflightError[] }> {
  const root = resolve(inputRoot); const allowed = new Set((options.extensions ?? ['.png', '.jpg', '.jpeg', '.psd', '.psb']).map((ext) => ext.toLowerCase()));
  const files: PreflightFile[] = []; const errors: PreflightError[] = [];
  const policy = options.sourceRootPolicy ?? assertSourceRootReadOnly;
  try { await policy(root); } catch (error) { const e = error as PathSafetyError; return { files, errors: [{ code: e.code ?? 'SOURCE_ROOT_WRITABLE', path: root, message: e.message }] }; }
  if (options.outputRoot) try { await validateOutputRoot(root, options.outputRoot); } catch (error) { const e = error as PathSafetyError; errors.push({ code: e.code, path: options.outputRoot, message: e.message }); }
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name); let relativePath: string;
      try { relativePath = canonicalRelativePath(root, absolute); } catch (error) { const e = error as PathSafetyError; errors.push({ code: e.code, path: absolute, message: e.message }); continue; }
      if (entry.isSymbolicLink()) { errors.push({ code: 'SYMLINK_ESCAPE', path: relativePath, message: 'symbolic links are not valid input roots' }); continue; }
      if (entry.isDirectory()) { await walk(absolute); continue; }
      if (!entry.isFile()) continue;
      const extension = relativePath.slice(relativePath.lastIndexOf('.')).toLowerCase();
      if (!allowed.has(extension)) { if (['.gif', '.bmp', '.tif', '.tiff', '.webp'].includes(extension)) errors.push({ code: 'UNSUPPORTED_FORMAT', path: relativePath, message: `unsupported input format: ${extension}` }); continue; }
      try {
        validateWindowsComponent(entry.name);
        if (options.maxPathBytes !== undefined && Buffer.byteLength(relativePath, 'utf8') > options.maxPathBytes) throw new PathSafetyError('PATH_TOO_LONG', `input path exceeds ${options.maxPathBytes} bytes`);
        await assertExistingConfinedPath(root, absolute);
        const bytes = await readFile(absolute); if (bytes.byteLength === 0) throw new PathSafetyError('ZERO_BYTE', 'image is zero bytes');
        if (extension === '.psd' || extension === '.psb') {
          if (!options.psdValidator) throw new PathSafetyError('PSD_VALIDATOR_REQUIRED', 'PSD/PSB validation requires a qualified backend validator');
          if (!await options.psdValidator({ bytes, path: absolute })) throw new PathSafetyError('CORRUPT_IMAGE', 'qualified PSD/PSB validator rejected the file');
        } else await (options.rasterValidator ?? decodeRaster)({ bytes, path: absolute });
        await assertExistingConfinedPath(root, absolute);
        files.push({ absolutePath: absolute, relativePath, sha256: sha256Bytes(bytes), bytes: bytes.byteLength, selectedAtMs: Date.now() });
      } catch (error) { const e = error as PathSafetyError; errors.push({ code: e.code ?? 'INVALID_INPUT', path: relativePath, message: e.message }); }
    }
  }
  await walk(root); files.sort((a, b) => Buffer.from(a.relativePath).compare(Buffer.from(b.relativePath)));
  if (options.outputRoot) for (const file of files) { try { validateOutputPathBudget(options.outputRoot, file.relativePath.replaceAll('/', '--'), '1.png', options.maxPathBytes ?? 240); } catch (error) { const e = error as PathSafetyError; errors.push({ code: e.code, path: file.relativePath, message: e.message }); } }
  return { files, errors };
}

export async function validateSourceSnapshot(file: PreflightFile): Promise<void> {
  const info = await lstat(file.absolutePath); const currentBytes = await readFile(file.absolutePath); const current = sha256Bytes(currentBytes);
  if (!info.isFile() || info.size !== file.bytes || current !== file.sha256) { const error = new Error(`source changed after selection: ${file.relativePath}`) as Error & { code: string }; error.code = 'SOURCE_CHANGED'; throw error; }
}

export async function readValidatedSource(file: PreflightFile): Promise<Buffer> {
  const bytes = await readFile(file.absolutePath);
  const info = await lstat(file.absolutePath);
  if (!info.isFile() || bytes.byteLength !== file.bytes || sha256Bytes(bytes) !== file.sha256) { const error = new Error(`source changed after selection: ${file.relativePath}`) as Error & { code: string }; error.code = 'SOURCE_CHANGED'; throw error; }
  return bytes;
}

export async function validateBeforeBackendBoundary(sourceRoot: string, policy: SourceRootPolicy = assertSourceRootReadOnly): Promise<void> {
  await policy(resolve(sourceRoot));
}
