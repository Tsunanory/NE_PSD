import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDiagnosticSink } from '../../packages/core/src/diagnostics.js';
import { createSupportBundle } from '../../packages/core/src/support-bundle.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'ne-psd-diagnostics-'));
  roots.push(path);
  return path;
}

describe('local diagnostic support', () => {
  it('writes correlation IDs and relative evidence references without private payload fields', async () => {
    const directory = await root();
    const sink = await createDiagnosticSink({ directory, now: () => new Date('2026-09-30T00:00:00Z') });
    await sink.record({ jobId: 'job_1', assetId: 'asset_1', attempt: 1, operationId: 'op_1', reviewSessionId: 'session_1', phase: 'review', durationMs: 27, errorCode: 'REVIEW_BLOCKED', evidenceRef: 'attempt/review/check.json' });
    await expect(sink.record({ jobId: 'job_1', phase: 'review', sourcePath: '/private/source.psd' } as never)).rejects.toThrow(/unsupported fields/);
    await expect(sink.record({ jobId: 'job_1', phase: 'review', evidenceRef: '/private/source.psd' })).rejects.toThrow(/evidence reference/);
    const output = await createSupportBundle({ diagnosticsPath: sink.path, outputDirectory: join(directory, 'support'), now: () => new Date('2026-09-30T00:01:00Z') });
    const bundle = JSON.parse(await readFile(output, 'utf8'));
    expect(bundle.records).toEqual([{ timestamp: '2026-09-30T00:00:00.000Z', jobId: 'job_1', assetId: 'asset_1', attempt: 1, operationId: 'op_1', reviewSessionId: 'session_1', phase: 'review', durationMs: 27, errorCode: 'REVIEW_BLOCKED', evidenceRef: 'attempt/review/check.json' }]);
    expect(JSON.stringify(bundle)).not.toContain('/private/');
    expect((await stat(output)).mode & 0o777).toBe(0o600);
  });

  it('strips unsupported fields from an imported log and rejects unsafe references', async () => {
    const directory = await root();
    const log = join(directory, 'diagnostics.jsonl');
    await writeFile(log, `${JSON.stringify({ timestamp: '2026-09-30T00:00:00Z', jobId: 'job_1', phase: 'render', sourceBytes: 'secret', prompt: 'private prompt' })}\n`);
    const output = await createSupportBundle({ diagnosticsPath: log, outputDirectory: join(directory, 'support') });
    expect(await readFile(output, 'utf8')).not.toMatch(/secret|private prompt/);
    await writeFile(log, `${JSON.stringify({ timestamp: '2026-09-30T00:00:00Z', jobId: 'job_1', phase: 'render', evidenceRef: '../secret' })}\n`);
    await expect(createSupportBundle({ diagnosticsPath: log, outputDirectory: join(directory, 'support') })).rejects.toThrow(/evidence reference/);
  });

  it('refuses oversized logs and symlinked log files', async () => {
    const directory = await root();
    const log = join(directory, 'large.jsonl');
    await writeFile(log, Buffer.alloc(4 * 1024 * 1024 + 1));
    await expect(createSupportBundle({ diagnosticsPath: log, outputDirectory: join(directory, 'support') })).rejects.toThrow(/support limit/);
    const link = join(directory, 'linked.jsonl');
    await symlink(log, link);
    await expect(createSupportBundle({ diagnosticsPath: link, outputDirectory: join(directory, 'support') })).rejects.toThrow(/unsafe/);
  });

  it('keeps support exports inside local diagnostic storage', async () => {
    const directory = await root();
    const other = await root();
    const sink = await createDiagnosticSink({ directory });
    await sink.record({ jobId: 'job_1', phase: 'setup' });
    await expect(createSupportBundle({ diagnosticsPath: sink.path, outputDirectory: join(other, 'support') })).rejects.toThrow(/local diagnostic storage/);
  });
});
