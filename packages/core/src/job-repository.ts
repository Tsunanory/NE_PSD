import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AssetStatus, DomainError, JobEvent, JobSnapshot, JobSpec } from '@ne-psd/contracts';
import { makeEvent, type EventKind } from './events.js';
import { assertAssetTransition, assertSnapshotCounters } from './state-machine.js';

type Sqlite = InstanceType<typeof Database>;
const migrationPath = join(dirname(fileURLToPath(import.meta.url)), 'migrations/001-initial.sql');
const MIGRATION = readFileSync(existsSync(migrationPath) ? migrationPath : join(dirname(migrationPath), '../../src/migrations/001-initial.sql'), 'utf8');

export class JobRepository {
  readonly db: Sqlite;
  constructor(pathOrDatabase: string | Sqlite) {
    if (typeof pathOrDatabase === 'string') { mkdirSync(dirname(pathOrDatabase), { recursive: true }); this.db = new Database(pathOrDatabase); }
    else this.db = pathOrDatabase;
    this.db.pragma('foreign_keys = ON'); this.db.pragma('journal_mode = WAL'); this.db.pragma('synchronous = NORMAL'); this.db.exec(MIGRATION);
  }
  close(): void { this.db.close(); }
  migrate(): void { this.db.exec(MIGRATION); }
  createJob(spec: JobSpec, parentJobId: string | null = null): void {
    const now = new Date().toISOString();
    const insert = this.db.transaction(() => {
      this.db.prepare('INSERT INTO jobs(job_id,spec_json,state,schema_version,contract_version,parent_job_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(spec.jobId, JSON.stringify(spec), 'ready', spec.schemaVersion, 1, parentJobId, now, now);
      const stmt = this.db.prepare('INSERT INTO assets(asset_id,job_id,source_json,status,attempt,error_json) VALUES(?,?,?,?,?,NULL)');
      for (const asset of spec.assets) stmt.run(asset.assetId, spec.jobId, JSON.stringify(asset), 'queued', 0);
    });
    insert();
  }
  private row(assetId: string): { job_id: string; status: AssetStatus; attempt: number; error_json: string | null } {
    const row = this.db.prepare('SELECT job_id,status,attempt,error_json FROM assets WHERE asset_id=?').get(assetId) as { job_id: string; status: AssetStatus; attempt: number; error_json: string | null } | undefined;
    if (!row) throw new Error(`unknown asset: ${assetId}`); return row;
  }
  transition(assetId: string, to: AssetStatus, error?: DomainError): void {
    const transaction = this.db.transaction(() => {
      const current = this.row(assetId); assertAssetTransition(current.status, to);
      const attempt = to === 'rendering' ? Math.min(2, current.attempt + 1) : current.attempt;
      if (to === 'rendering' && current.attempt >= 2) throw Object.assign(new Error('automatic attempt limit reached'), { code: 'ATTEMPT_LIMIT' });
      this.db.prepare('UPDATE assets SET status=?,attempt=?,error_json=? WHERE asset_id=?').run(to, attempt, error ? JSON.stringify(error) : null, assetId);
      this.db.prepare('UPDATE jobs SET state=?,updated_at=? WHERE job_id=?').run(this.deriveJobState(current.job_id), new Date().toISOString(), current.job_id);
    });
    transaction();
  }
  private deriveJobState(jobId: string): string {
    const rows = this.db.prepare('SELECT status FROM assets WHERE job_id=?').all(jobId) as Array<{ status: AssetStatus }>;
    if (rows.length > 0 && rows.every((row) => row.status === 'complete' || row.status === 'cancelled')) return rows.some((row) => row.status === 'complete') ? 'completed' : 'cancelled';
    if (rows.some((row) => row.status === 'blocked')) return 'blocked';
    if (rows.every((row) => row.status === 'failed' || row.status === 'cancelled')) return 'failed';
    if (rows.some((row) => row.status === 'rendering' || row.status === 'reviewing' || row.status === 'readyToCommit')) return 'running';
    return 'ready';
  }
  snapshot(jobId: string): JobSnapshot {
    const rows = this.db.prepare('SELECT asset_id,status,attempt,error_json FROM assets WHERE job_id=? ORDER BY asset_id').all(jobId) as Array<{ asset_id: string; status: AssetStatus; attempt: number; error_json: string | null }>;
    if (!this.db.prepare('SELECT 1 FROM jobs WHERE job_id=?').get(jobId)) throw new Error(`unknown job: ${jobId}`);
    const jobRow = this.db.prepare('SELECT state FROM jobs WHERE job_id=?').get(jobId) as { state: JobSnapshot['state'] } | undefined;
    const snapshot: JobSnapshot = { jobId, state: jobRow?.state ?? 'ready', total: rows.length, complete: rows.filter((row) => row.status === 'complete').length, failed: rows.filter((row) => row.status === 'failed').length, blocked: rows.filter((row) => row.status === 'blocked').length, assets: rows.map((row) => ({ assetId: row.asset_id, status: row.status, attempt: row.attempt, error: row.error_json ? JSON.parse(row.error_json) as DomainError : null })) };
    assertSnapshotCounters(snapshot); return snapshot;
  }
  appendEvent(jobId: string, kind: EventKind): JobEvent {
    const event = this.db.transaction(() => {
      const next = (this.db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM events WHERE job_id=?').get(jobId) as { sequence: number }).sequence;
      const value = makeEvent(jobId, next, kind, this.snapshot(jobId));
      this.db.prepare('INSERT INTO events(job_id,sequence,kind,event_json,created_at) VALUES(?,?,?,?,?)').run(jobId, next, kind, JSON.stringify(value), value.timestamp);
      return value;
    })();
    return event;
  }
  events(jobId: string): JobEvent[] { return (this.db.prepare('SELECT event_json FROM events WHERE job_id=? ORDER BY sequence').all(jobId) as Array<{ event_json: string }>).map((row) => JSON.parse(row.event_json) as JobEvent); }
  requestPause(jobId: string): void { this.db.prepare("UPDATE jobs SET state='pausing',updated_at=? WHERE job_id=? AND state IN ('ready','running')").run(new Date().toISOString(), jobId); }
  pause(jobId: string): void { this.requestPause(jobId); }
  markPaused(jobId: string): void { this.db.prepare("UPDATE jobs SET state='paused',updated_at=? WHERE job_id=? AND state='pausing'").run(new Date().toISOString(), jobId); }
  resume(jobId: string): void { this.db.prepare("UPDATE jobs SET state='running',updated_at=? WHERE job_id=? AND state IN ('pausing','paused')").run(new Date().toISOString(), jobId); }
  cancel(jobId: string): void { this.db.transaction(() => { this.db.prepare("UPDATE assets SET status='cancelled' WHERE job_id=? AND status NOT IN ('complete','cancelled')").run(jobId); this.db.prepare("UPDATE jobs SET state='cancelled',updated_at=? WHERE job_id=?").run(new Date().toISOString(), jobId); })(); }
  retryFailed(jobId: string, selectedAssetIds?: readonly string[]): { jobId: string } {
    return this.db.transaction(() => {
      const source = this.db.prepare('SELECT spec_json FROM jobs WHERE job_id=?').get(jobId) as { spec_json: string } | undefined; if (!source) throw new Error(`unknown job: ${jobId}`);
      const failed = this.db.prepare("SELECT asset_id FROM assets WHERE job_id=? AND status='failed'").all(jobId) as Array<{ asset_id: string }>;
      const allowed = new Set(failed.map((asset) => asset.asset_id)); const chosen = selectedAssetIds ? selectedAssetIds.filter((id) => allowed.has(id)) : failed.map((asset) => asset.asset_id);
      if (chosen.length === 0) throw Object.assign(new Error('no failed assets to retry; blocked review work requires review recovery'), { code: 'NO_FAILED_ASSETS' });
      const spec = JSON.parse(source.spec_json) as JobSpec; const successorId = randomUUID(); const successor: JobSpec = { ...spec, jobId: successorId, assets: spec.assets.filter((asset) => chosen.includes(asset.assetId)) };
      this.createJob(successor, jobId); return { jobId: successorId };
    })();
  }
  getJobSpec(jobId: string): JobSpec { const row = this.db.prepare('SELECT spec_json FROM jobs WHERE job_id=?').get(jobId) as { spec_json: string } | undefined; if (!row) throw new Error(`unknown job: ${jobId}`); return JSON.parse(row.spec_json) as JobSpec; }
  listPublications(jobId: string): Array<{ assetId: string; path: string; transactionKey: string }> { return (this.db.prepare('SELECT asset_id AS assetId,path,transaction_key AS transactionKey FROM publications WHERE job_id=? ORDER BY asset_id').all(jobId) as Array<{ assetId: string; path: string; transactionKey: string }>); }
}
