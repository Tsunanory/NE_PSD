import { appendFile, lstat, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';

export type DiagnosticEvent = {
  jobId: string;
  assetId?: string;
  attempt?: 1 | 2;
  operationId?: string;
  reviewSessionId?: string;
  phase: 'setup' | 'preflight' | 'render' | 'review' | 'publish' | 'recover';
  durationMs?: number;
  errorCode?: string;
  evidenceRef?: string;
};

export type DiagnosticRecord = DiagnosticEvent & { timestamp: string };

const EVENT_FIELDS = new Set(['jobId', 'assetId', 'attempt', 'operationId', 'reviewSessionId', 'phase', 'durationMs', 'errorCode', 'evidenceRef']);
const PHASES = new Set<DiagnosticEvent['phase']>(['setup', 'preflight', 'render', 'review', 'publish', 'recover']);

function safeId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function safeEvidenceRef(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && !value.includes('\\') && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && /^[A-Za-z0-9_.-]+$/.test(part));
}

export function validateDiagnosticEvent(value: unknown): DiagnosticEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('diagnostic event must be an object');
  const event = value as Record<string, unknown>;
  if (Object.keys(event).some((key) => !EVENT_FIELDS.has(key))) throw new Error('diagnostic event contains unsupported fields');
  if (!safeId(event.jobId) || !PHASES.has(event.phase as DiagnosticEvent['phase'])) throw new Error('diagnostic identity or phase is invalid');
  for (const key of ['assetId', 'operationId', 'reviewSessionId'] as const) if (event[key] !== undefined && !safeId(event[key])) throw new Error(`diagnostic ${key} is invalid`);
  if (event.attempt !== undefined && event.attempt !== 1 && event.attempt !== 2) throw new Error('diagnostic attempt is invalid');
  if (event.durationMs !== undefined && (typeof event.durationMs !== 'number' || !Number.isFinite(event.durationMs) || event.durationMs < 0)) throw new Error('diagnostic duration is invalid');
  if (event.errorCode !== undefined && (typeof event.errorCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(event.errorCode))) throw new Error('diagnostic error code is invalid');
  if (event.evidenceRef !== undefined && !safeEvidenceRef(event.evidenceRef)) throw new Error('diagnostic evidence reference is invalid');
  return event as DiagnosticEvent;
}

export async function createDiagnosticSink(input: { directory: string; now?: () => Date }) {
  await mkdir(input.directory, { recursive: true });
  if ((await lstat(input.directory)).isSymbolicLink()) throw new Error('diagnostic directory is a symlink');
  const directory = await realpath(input.directory);
  const path = join(directory, 'diagnostics.jsonl');
  return {
    path,
    async record(event: DiagnosticEvent): Promise<void> {
      const validated = validateDiagnosticEvent(event);
      const timestamp = (input.now ?? (() => new Date()))().toISOString();
      try { if ((await lstat(path)).isSymbolicLink()) throw new Error('diagnostic log is a symlink'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await appendFile(path, `${JSON.stringify({ timestamp, ...validated })}\n`, { encoding: 'utf8', mode: 0o600 });
    },
  };
}

export function sanitizeDiagnosticRecord(value: unknown): DiagnosticRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('diagnostic record is invalid');
  const row = value as Record<string, unknown>;
  if (typeof row.timestamp !== 'string' || !Number.isFinite(Date.parse(row.timestamp))) throw new Error('diagnostic timestamp is invalid');
  const event = Object.fromEntries([...EVENT_FIELDS].filter((key) => row[key] !== undefined).map((key) => [key, row[key]]));
  return { timestamp: row.timestamp, ...validateDiagnosticEvent(event) };
}
