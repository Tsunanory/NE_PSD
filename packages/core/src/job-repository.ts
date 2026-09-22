import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AssetStatus, DomainError, JobEvent, JobSnapshot, JobSpec } from '@ne-psd/contracts';
import { TemplateProfileSchema, sha256Json } from '@ne-psd/contracts';
import { makeEvent, type EventKind } from './events.js';
import { assertAssetTransition, assertSnapshotCounters } from './state-machine.js';

type Sqlite = InstanceType<typeof Database>;
type AssetRow = { job_id: string; asset_id: string; status: AssetStatus; attempt: number; error_json: string | null };
const migrationDirectory = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const MIGRATIONS = [
  { version: 1, sql: readFileSync(join(migrationDirectory, '001-initial.sql'), 'utf8') },
  { version: 2, sql: readFileSync(join(migrationDirectory, '002-attempt-foreign-keys.sql'), 'utf8') },
  { version: 3, sql: readFileSync(join(migrationDirectory, '003-qualified-profile.sql'), 'utf8') },
  { version: 4, sql: readFileSync(join(migrationDirectory, '004-job-output-root.sql'), 'utf8') },
];

export type ReviewRecord = { reviewId: string; jobId: string; assetId: string; attempt: number; payload: unknown };
export type PublicationRecord = { publicationId: string; jobId: string; assetId: string; attempt: number; transactionKey: string; path: string; manifest?: unknown };
export type QualificationRecord = { qualificationId: string; profileId: string; profileSha256: string; evidence: unknown; profile: unknown };
export type OutputRootBinding = { rootId: string; canonicalRoot: string; canonicalRootIdentity: string };

export class JobRepository {
  readonly db: Sqlite;
  constructor(pathOrDatabase: string | Sqlite) {
    if (typeof pathOrDatabase === 'string') { mkdirSync(dirname(pathOrDatabase), { recursive: true }); this.db = new Database(pathOrDatabase); }
    else this.db = pathOrDatabase;
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.migrate();
  }
  close(): void { this.db.close(); }
  migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    for (const migration of MIGRATIONS) {
      const applied = this.db.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(migration.version);
      if (applied) continue;
      this.db.transaction(() => {
        this.db.exec(migration.sql);
        this.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(?,?)').run(migration.version, new Date().toISOString());
      })();
    }
  }

  createJob(spec: JobSpec, parentJobId: string | null = null, outputRoot?: OutputRootBinding): void {
    if (!outputRoot || outputRoot.rootId !== spec.outputRootId || !outputRoot.canonicalRoot.startsWith('/') || outputRoot.canonicalRootIdentity !== createHash('sha256').update(outputRoot.canonicalRoot).digest('hex')) throw Object.assign(new Error('trusted output-root binding is required'), { code: 'OUTPUT_ROOT_BINDING_REQUIRED' });
    if (spec.profile.profileSha256 !== sha256Json(spec.profile, { excludeKeys: ['profileSha256'] })) throw Object.assign(new Error('template profile digest mismatch'), { code: 'PROFILE_DIGEST_MISMATCH' });
    const qualification = this.db.prepare('SELECT profile_id,profile_sha256,profile_json FROM qualifications WHERE qualification_id=?').get(spec.profile.qualificationId) as { profile_id: string; profile_sha256: string; profile_json: string | null } | undefined;
    if (!qualification) throw Object.assign(new Error('template qualification record is required'), { code: 'QUALIFICATION_REQUIRED' });
    if (!qualification.profile_json) throw Object.assign(new Error('sealed profile content is required'), { code: 'QUALIFICATION_UNSEALED' });
    const sealed = TemplateProfileSchema.safeParse(JSON.parse(qualification.profile_json));
    if (!sealed.success || sealed.data.profileId !== qualification.profile_id || sealed.data.profileSha256 !== qualification.profile_sha256 || sha256Json(sealed.data, { excludeKeys: ['profileSha256'] }) !== qualification.profile_sha256) throw Object.assign(new Error('persisted qualification profile is invalid'), { code: 'QUALIFICATION_MISMATCH' });
    if (qualification.profile_id !== spec.profile.profileId || qualification.profile_sha256 !== spec.profile.profileSha256) throw Object.assign(new Error('template qualification does not match profile'), { code: 'QUALIFICATION_MISMATCH' });
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO jobs(job_id,spec_json,state,schema_version,contract_version,parent_job_id,requested_control,created_at,updated_at,output_root_path,output_root_identity) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(spec.jobId, JSON.stringify(spec), 'ready', spec.schemaVersion, 1, parentJobId, null, now, now, outputRoot.canonicalRoot, outputRoot.canonicalRootIdentity);
      const insert = this.db.prepare('INSERT INTO assets(asset_id,job_id,source_json,status,attempt,error_json) VALUES(?,?,?,?,?,NULL)');
      for (const asset of spec.assets) insert.run(asset.assetId, spec.jobId, JSON.stringify(asset), 'queued', 0);
    })();
  }

  private row(jobId: string, assetId: string): AssetRow {
    const row = this.db.prepare('SELECT job_id,asset_id,status,attempt,error_json FROM assets WHERE job_id=? AND asset_id=?').get(jobId, assetId) as AssetRow | undefined;
    if (!row) throw new Error(`unknown asset: ${jobId}/${assetId}`);
    return row;
  }
  private jobControl(jobId: string): string | null {
    return (this.db.prepare('SELECT requested_control FROM jobs WHERE job_id=?').get(jobId) as { requested_control: string | null } | undefined)?.requested_control ?? null;
  }

  transition(jobId: string, assetId: string, to: AssetStatus, error?: DomainError): void {
    this.db.transaction(() => {
      const current = this.row(jobId, assetId);
      assertAssetTransition(current.status, to);
      if (this.jobControl(current.job_id) === 'cancel' && !['complete', 'failed', 'blocked', 'cancelled'].includes(to)) throw Object.assign(new Error('cancel requested; await safe-boundary acknowledgement'), { code: 'CONTROL_REQUESTED' });
      const attempt = to === 'rendering' ? current.attempt + 1 : current.attempt;
      if (to === 'rendering' && current.attempt >= 2) throw Object.assign(new Error('automatic attempt limit reached'), { code: 'ATTEMPT_LIMIT' });
      this.db.prepare('UPDATE assets SET status=?,attempt=?,error_json=? WHERE job_id=? AND asset_id=?').run(to, attempt, error ? JSON.stringify(error) : null, current.job_id, assetId);
      if (to === 'rendering') this.db.prepare('INSERT INTO attempts(job_id,asset_id,attempt,transaction_key,state,evidence_json,created_at) VALUES(?,?,?,?,?,?,?)').run(current.job_id, assetId, attempt, `${current.job_id}:${assetId}:${attempt}`, 'rendering', null, new Date().toISOString());
      const state = this.jobControl(current.job_id) === 'pause' ? 'pausing' : this.deriveJobState(current.job_id);
      this.db.prepare('UPDATE jobs SET state=?,updated_at=? WHERE job_id=?').run(state, new Date().toISOString(), current.job_id);
    })();
  }

  private deriveJobState(jobId: string): string {
    const rows = this.db.prepare('SELECT status FROM assets WHERE job_id=?').all(jobId) as Array<{ status: AssetStatus }>;
    if (rows.some((row) => row.status === 'blocked')) return 'blocked';
    if (rows.some((row) => row.status === 'failed')) return 'failed';
    if (rows.length > 0 && rows.every((row) => row.status === 'complete' || row.status === 'cancelled')) return rows.some((row) => row.status === 'complete') ? 'completed' : 'cancelled';
    if (rows.some((row) => ['rendering', 'reviewing', 'readyToCommit'].includes(row.status))) return 'running';
    return 'ready';
  }

  snapshot(jobId: string): JobSnapshot {
    const job = this.db.prepare('SELECT state FROM jobs WHERE job_id=?').get(jobId) as { state: JobSnapshot['state'] } | undefined;
    if (!job) throw new Error(`unknown job: ${jobId}`);
    const rows = this.db.prepare('SELECT asset_id,status,attempt,error_json FROM assets WHERE job_id=? ORDER BY asset_id').all(jobId) as Array<{ asset_id: string; status: AssetStatus; attempt: number; error_json: string | null }>;
    const snapshot: JobSnapshot = { jobId, state: job.state, total: rows.length, complete: rows.filter((row) => row.status === 'complete').length, failed: rows.filter((row) => row.status === 'failed').length, blocked: rows.filter((row) => row.status === 'blocked').length, assets: rows.map((row) => ({ assetId: row.asset_id, status: row.status, attempt: row.attempt, error: row.error_json ? JSON.parse(row.error_json) as DomainError : null })) };
    assertSnapshotCounters(snapshot);
    return snapshot;
  }

  appendEvent(jobId: string, kind: EventKind): JobEvent {
    return this.db.transaction(() => {
      const next = (this.db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM events WHERE job_id=?').get(jobId) as { sequence: number }).sequence;
      const event = makeEvent(jobId, next, kind, this.snapshot(jobId));
      this.db.prepare('INSERT INTO events(job_id,sequence,kind,event_json,created_at) VALUES(?,?,?,?,?)').run(jobId, next, kind, JSON.stringify(event), event.timestamp);
      return event;
    })();
  }
  events(jobId: string): JobEvent[] { return (this.db.prepare('SELECT event_json FROM events WHERE job_id=? ORDER BY sequence').all(jobId) as Array<{ event_json: string }>).map((row) => JSON.parse(row.event_json) as JobEvent); }
  attempts(jobId: string, assetId: string): unknown[] { return this.db.prepare('SELECT * FROM attempts WHERE job_id=? AND asset_id=? ORDER BY attempt').all(jobId, assetId) as unknown[]; }
  recordReview(record: ReviewRecord): void { this.db.prepare('INSERT INTO reviews(review_id,job_id,asset_id,attempt,review_json,created_at) VALUES(?,?,?,?,?,?)').run(record.reviewId, record.jobId, record.assetId, record.attempt, JSON.stringify(record.payload), new Date().toISOString()); }
  recordPublication(record: PublicationRecord): void {
    const job = this.db.prepare('SELECT output_root_path AS root,output_root_identity AS identity FROM jobs WHERE job_id=?').get(record.jobId) as { root: string | null; identity: string | null } | undefined;
    const expected = `${record.jobId}:${record.assetId}:${record.attempt}`;
    if (!job?.root || !job.identity || record.transactionKey !== expected || !record.path.startsWith(`${job.root}/`)) throw Object.assign(new Error('publication is outside trusted output root or has invalid transaction identity'), { code: 'PUBLICATION_BINDING_MISMATCH' });
    this.db.prepare('INSERT INTO publications(publication_id,job_id,asset_id,attempt,transaction_key,path,manifest_json,created_at) VALUES(?,?,?,?,?,?,?,?)').run(record.publicationId, record.jobId, record.assetId, record.attempt, expected, record.path, record.manifest === undefined ? null : JSON.stringify(record.manifest), new Date().toISOString());
  }
  recordQualification(record: QualificationRecord): void {
    const profile = TemplateProfileSchema.safeParse(record.profile);
    if (!profile.success || profile.data.profileId !== record.profileId || profile.data.profileSha256 !== record.profileSha256 || sha256Json(profile.data, { excludeKeys: ['profileSha256'] }) !== record.profileSha256) throw Object.assign(new Error('qualification profile digest mismatch'), { code: 'QUALIFICATION_MISMATCH' });
    this.db.prepare('INSERT INTO qualifications(qualification_id,profile_id,profile_sha256,evidence_json,profile_json,created_at) VALUES(?,?,?,?,?,?)').run(record.qualificationId, record.profileId, record.profileSha256, JSON.stringify(record.evidence), JSON.stringify(profile.data), new Date().toISOString());
  }
  getQualification(qualificationId: string): QualificationRecord | null { const row = this.db.prepare('SELECT qualification_id AS qualificationId,profile_id AS profileId,profile_sha256 AS profileSha256,evidence_json,profile_json FROM qualifications WHERE qualification_id=?').get(qualificationId) as ({ qualificationId: string; profileId: string; profileSha256: string; evidence_json: string; profile_json: string | null } | undefined); return row && row.profile_json ? { qualificationId: row.qualificationId, profileId: row.profileId, profileSha256: row.profileSha256, evidence: JSON.parse(row.evidence_json), profile: JSON.parse(row.profile_json) } : null; }

  requestPause(jobId: string): void { this.db.prepare("UPDATE jobs SET state='pausing',requested_control='pause',updated_at=? WHERE job_id=? AND state IN ('ready','running')").run(new Date().toISOString(), jobId); }
  pause(jobId: string): void { this.requestPause(jobId); }
  controlState(jobId: string): string | null { return this.jobControl(jobId); }
  acknowledgePause(jobId: string): void { this.db.prepare("UPDATE jobs SET state='paused',requested_control=NULL,updated_at=? WHERE job_id=? AND requested_control='pause'").run(new Date().toISOString(), jobId); }
  resume(jobId: string): void { this.db.prepare("UPDATE jobs SET state='running',requested_control=NULL,updated_at=? WHERE job_id=? AND state IN ('pausing','paused')").run(new Date().toISOString(), jobId); }
  requestCancel(jobId: string): void { this.db.prepare("UPDATE jobs SET requested_control='cancel',updated_at=? WHERE job_id=? AND state NOT IN ('completed','failed','blocked','cancelled')").run(new Date().toISOString(), jobId); }
  cancel(jobId: string): void { this.requestCancel(jobId); }
  acknowledgeCancel(jobId: string): void { this.db.transaction(() => { this.db.prepare("UPDATE assets SET status='cancelled' WHERE job_id=? AND status NOT IN ('complete','cancelled')").run(jobId); this.db.prepare("UPDATE jobs SET state='cancelled',requested_control=NULL,updated_at=? WHERE job_id=? AND requested_control='cancel'").run(new Date().toISOString(), jobId); })(); }

  retryFailed(jobId: string, selectedAssetIds?: readonly string[]): { jobId: string } {
    return this.db.transaction(() => {
      const source = this.db.prepare('SELECT spec_json FROM jobs WHERE job_id=?').get(jobId) as { spec_json: string } | undefined;
      if (!source) throw new Error(`unknown job: ${jobId}`);
      const failed = this.db.prepare("SELECT asset_id FROM assets WHERE job_id=? AND status='failed'").all(jobId) as Array<{ asset_id: string }>;
      const allowed = new Set(failed.map((asset) => asset.asset_id));
      const chosen = selectedAssetIds ? [...selectedAssetIds] : [...allowed];
      if (chosen.length === 0 || new Set(chosen).size !== chosen.length || chosen.some((id) => !allowed.has(id))) throw Object.assign(new Error('no valid failed assets to retry; blocked review work requires recovery'), { code: 'NO_FAILED_ASSETS' });
      const spec = JSON.parse(source.spec_json) as JobSpec;
      const successor: JobSpec = { ...spec, jobId: randomUUID(), assets: spec.assets.filter((asset) => chosen.includes(asset.assetId)) };
      const root = this.db.prepare('SELECT output_root_path AS canonicalRoot,output_root_identity AS canonicalRootIdentity FROM jobs WHERE job_id=?').get(jobId) as { canonicalRoot: string | null; canonicalRootIdentity: string | null } | undefined;
      if (!root?.canonicalRoot || !root.canonicalRootIdentity) throw Object.assign(new Error('trusted output-root binding is required'), { code: 'OUTPUT_ROOT_BINDING_REQUIRED' });
      this.createJob(successor, jobId, { rootId: successor.outputRootId, canonicalRoot: root.canonicalRoot, canonicalRootIdentity: root.canonicalRootIdentity });
      return { jobId: successor.jobId };
    })();
  }
  getJobSpec(jobId: string): JobSpec { const row = this.db.prepare('SELECT spec_json FROM jobs WHERE job_id=?').get(jobId) as { spec_json: string } | undefined; if (!row) throw new Error(`unknown job: ${jobId}`); return JSON.parse(row.spec_json) as JobSpec; }
  listPublications(jobId: string): Array<{ assetId: string; path: string; transactionKey: string }> { return this.db.prepare('SELECT asset_id AS assetId,path,transaction_key AS transactionKey FROM publications WHERE job_id=? ORDER BY asset_id').all(jobId) as Array<{ assetId: string; path: string; transactionKey: string }>; }
}
