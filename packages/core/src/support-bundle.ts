import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { sanitizeDiagnosticRecord, type DiagnosticRecord } from './diagnostics.js';

const MAX_LOG_BYTES = 4 * 1024 * 1024;
const MAX_RECORDS = 10_000;

export type LocalSupportBundle = {
  schemaVersion: 1;
  generatedAt: string;
  records: DiagnosticRecord[];
};

export async function createSupportBundle(input: { diagnosticsPath: string; outputDirectory: string; now?: () => Date }): Promise<string> {
  const source = await lstat(input.diagnosticsPath);
  if (!source.isFile() || source.isSymbolicLink() || source.size > MAX_LOG_BYTES) throw new Error('diagnostic log is unsafe or exceeds support limit');
  const bytes = await readFile(input.diagnosticsPath);
  if (bytes.byteLength > MAX_LOG_BYTES) throw new Error('diagnostic log exceeds support limit');
  const lines = bytes.toString('utf8').split('\n').filter(Boolean);
  if (lines.length > MAX_RECORDS) throw new Error('diagnostic record count exceeds support limit');
  const records = lines.map((line) => sanitizeDiagnosticRecord(JSON.parse(line)));
  const diagnosticDirectory = await realpath(dirname(input.diagnosticsPath));
  await mkdir(input.outputDirectory, { recursive: true });
  if ((await lstat(input.outputDirectory)).isSymbolicLink()) throw new Error('support output directory is a symlink');
  const directory = await realpath(input.outputDirectory);
  const pathFromDiagnostics = relative(diagnosticDirectory, directory);
  if (!pathFromDiagnostics || pathFromDiagnostics === '..' || pathFromDiagnostics.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(pathFromDiagnostics)) throw new Error('support export must remain within local diagnostic storage');
  const outputPath = join(directory, `support-${randomUUID()}.json`);
  const bundle: LocalSupportBundle = { schemaVersion: 1, generatedAt: (input.now ?? (() => new Date()))().toISOString(), records };
  await writeFile(outputPath, JSON.stringify(bundle), { flag: 'wx', mode: 0o600 });
  return outputPath;
}
