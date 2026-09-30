import Database from 'better-sqlite3';
import { mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AssetStatus, DomainError, EvidenceBundleManifest, HumanVisualAttestationV1, JobEvent, JobSnapshot, JobSpec, RenderRequestV2, ReviewEvidence, VisualReviewRequest } from '@ne-psd/contracts';
import { EvidenceBundleManifestSchema, HumanVisualAttestationV1Schema, JobEventSchema, JobSnapshotSchema, RelativePathSchema, RenderRequestV2Schema, ReviewDecisionSchema, ReviewEvidenceSchema, TemplateProfileSchema, VisualReviewRequestSchema, bundleDigest, sha256Json, validateJobSpec } from '@ne-psd/contracts';
import type { ArtifactQaResult } from './artifact-qa.js';
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
  { version: 5, sql: readFileSync(join(migrationDirectory, '005-v2-attempt-intent.sql'), 'utf8') },
  { version: 6, sql: readFileSync(join(migrationDirectory, '006-publication-visual-intent.sql'), 'utf8') },
];

export type ReviewRecord = { reviewId: string; jobId: string; assetId: string; attempt: number; payload: unknown };
export type PublicationRecord = { publicationId: string; jobId: string; assetId: string; attempt: number; transactionKey: string; path: string; manifest?: unknown };
export type QualificationRecord = { qualificationId: string; profileId: string; profileSha256: string; evidence: unknown; profile: unknown };
export type OutputRootBinding = { rootId: string; canonicalRoot: string; canonicalRootIdentity: string };
export type V2AttemptIntent = { installationId: string; operationId: string; stagingDirectory: string; sourceRootIdentity: string };
export type PendingMutation = { schemaVersion: 1 | 2; jobId: string; assetId: string; attempt: number; operationId: string | null; stagingDirectory: string | null; sourceRootIdentity: string | null };
export type PublicationIntent = { jobId: string; assetId: string; attempt: 1 | 2; transactionKey: string; outputRootPath: string; outputRootIdentity: string; stagingDirectory: string; destinationPath: string; manifestSha256: string; reviewId: string; decisionSha256: string; reviewPolicySha256: string; modelProvenanceSha256: string; state: 'prepared' | 'renamed' | 'committed' | 'quarantined' };
export type VisualAttestationReceipt = { request: VisualReviewRequest; decision: 'approve' | 'reject'; operatorIdentity: string; consumed: true; consumedAt: string; expiresAt: string; attestationRelativePath: string; attestationSha256: string };
export type PendingReview = { jobId: string; assetId: string; attempt: 1 | 2; stagingDirectory: string;
  request: RenderRequestV2; evidence: ReviewEvidence; manifest: EvidenceBundleManifest; qa: ArtifactQaResult;
  reviewPolicySha256: string; plannerProfileSha256: string; reviewerProfileSha256: string };
export function filesystemIdentity(path: string): string { const info = statSync(path); return createHash('sha256').update(`${path}|${info.dev}|${info.ino}`).digest('hex'); }
function realpathWithExistingAncestor(path: string): string {
  try { return realpathSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = resolve(path, '..');
    if (parent === path) throw error;
    return resolve(realpathWithExistingAncestor(parent), path.slice(parent.length + 1));
  }
}

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

  createJob(input: unknown, parentJobId: string | null = null, outputRoot?: OutputRootBinding): void {
    const parsed = validateJobSpec(input);
    if (!parsed.success) throw Object.assign(new Error(`invalid job specification: ${parsed.error.message}`), { code: 'INVALID_JOB_SPEC' });
    const spec = parsed.data;
    if (!outputRoot || outputRoot.rootId !== spec.outputRootId || !isAbsolute(outputRoot.canonicalRoot) || outputRoot.canonicalRootIdentity !== filesystemIdentity(outputRoot.canonicalRoot) || realpathSync(outputRoot.canonicalRoot) !== outputRoot.canonicalRoot) throw Object.assign(new Error('trusted output-root binding is required'), { code: 'OUTPUT_ROOT_BINDING_REQUIRED' });
    if (spec.profile.profileSha256 !== sha256Json(spec.profile, { excludeKeys: ['profileSha256'] })) throw Object.assign(new Error('template profile digest mismatch'), { code: 'PROFILE_DIGEST_MISMATCH' });
    const qualification = this.db.prepare('SELECT profile_id,profile_sha256,profile_json FROM qualifications WHERE qualification_id=?').get(spec.profile.qualificationId) as { profile_id: string; profile_sha256: string; profile_json: string | null } | undefined;
    if (!qualification) throw Object.assign(new Error('template qualification record is required'), { code: 'QUALIFICATION_REQUIRED' });
    if (!qualification.profile_json) throw Object.assign(new Error('sealed profile content is required'), { code: 'QUALIFICATION_UNSEALED' });
    let persistedProfile: unknown;
    try { persistedProfile = JSON.parse(qualification.profile_json); } catch { throw Object.assign(new Error('persisted qualification profile is malformed'), { code: 'QUALIFICATION_MISMATCH' }); }
    const sealed = TemplateProfileSchema.safeParse(persistedProfile);
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
  private assertCurrentAttempt(jobId: string, assetId: string, attempt: number): void {
    const row = this.db.prepare('SELECT attempt FROM assets WHERE job_id=? AND asset_id=?').get(jobId, assetId) as { attempt: number } | undefined;
    if (!row) throw new Error(`unknown asset: ${jobId}/${assetId}`);
    if (row.attempt !== attempt) throw Object.assign(new Error('record does not match the current attempt'), { code: 'CURRENT_ATTEMPT_MISMATCH' });
  }
  private assertAttemptState(jobId: string, assetId: string, attempt: number, expected: AssetStatus, phase: string): void {
    this.assertCurrentAttempt(jobId, assetId, attempt);
    const row = this.db.prepare('SELECT status FROM assets WHERE job_id=? AND asset_id=?').get(jobId, assetId) as { status: AssetStatus } | undefined;
    if (row?.status !== expected) throw Object.assign(new Error(`record requires ${phase} phase`), { code: 'INVALID_LIFECYCLE_PHASE' });
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
    let assets: JobSnapshot['assets'];
    try { assets = rows.map((row) => ({ assetId: row.asset_id, status: row.status, attempt: row.attempt, error: row.error_json ? JSON.parse(row.error_json) as DomainError : null })); } catch { throw new Error('persisted asset error JSON is malformed'); }
    const snapshot: JobSnapshot = { jobId, state: job.state, total: rows.length, complete: rows.filter((row) => row.status === 'complete').length, failed: rows.filter((row) => row.status === 'failed').length, blocked: rows.filter((row) => row.status === 'blocked').length, assets };
    if (!JobSnapshotSchema.safeParse(snapshot).success) throw new Error('persisted job snapshot is invalid');
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
  events(jobId: string): JobEvent[] {
    try {
      return (this.db.prepare('SELECT sequence,event_json FROM events WHERE job_id=? ORDER BY sequence').all(jobId) as Array<{ sequence: number; event_json: string }>).map((row) => {
        const parsed = JobEventSchema.safeParse(JSON.parse(row.event_json));
        if (!parsed.success || parsed.data.jobId !== jobId || parsed.data.snapshot.jobId !== jobId || parsed.data.sequence !== row.sequence) throw new Error('invalid persisted event');
        return parsed.data;
      });
    } catch { throw new Error('persisted event JSON is malformed or invalid'); }
  }
  attempts(jobId: string, assetId: string): unknown[] { return this.db.prepare('SELECT * FROM attempts WHERE job_id=? AND asset_id=? ORDER BY attempt').all(jobId, assetId) as unknown[]; }
  beginV2Attempt(jobId: string, assetId: string, attempt: 1 | 2, intent: V2AttemptIntent): void {
    if (!intent.installationId || !intent.operationId || !isAbsolute(intent.stagingDirectory) || !/^[a-f0-9]{64}$/.test(intent.sourceRootIdentity)) throw Object.assign(new Error('invalid v2 operation intent'), { code: 'INVALID_V2_INTENT' });
    this.db.transaction(() => {
      const current = this.row(jobId, assetId);
      if (current.status !== 'queued' || current.attempt + 1 !== attempt || this.pendingMutations(intent.installationId).length > 0) throw Object.assign(new Error('unresolved mutation or invalid attempt state'), { code: 'MUTATION_BLOCKED' });
      this.transition(jobId, assetId, 'rendering');
      this.db.prepare('UPDATE attempts SET v2_installation_id=?,v2_operation_id=?,v2_staging_directory=?,v2_source_root_identity=?,v2_state=? WHERE job_id=? AND asset_id=? AND attempt=?').run(intent.installationId, intent.operationId, intent.stagingDirectory, intent.sourceRootIdentity, 'intent', jobId, assetId, attempt);
    })();
  }
  pendingMutations(installationId: string): PendingMutation[] {
    if (!installationId) throw new Error('installation identity required');
    return this.db.prepare(`SELECT CASE WHEN t.v2_operation_id IS NULL THEN 1 ELSE 2 END AS schemaVersion,
      t.job_id AS jobId,t.asset_id AS assetId,t.attempt,t.v2_operation_id AS operationId,
      t.v2_staging_directory AS stagingDirectory,t.v2_source_root_identity AS sourceRootIdentity
      FROM attempts t JOIN assets a ON a.job_id=t.job_id AND a.asset_id=t.asset_id
      WHERE (t.v2_operation_id IS NOT NULL AND t.v2_installation_id=? AND t.v2_state!='safe')
         OR (t.v2_operation_id IS NULL AND a.attempt=t.attempt AND a.status='rendering')
      ORDER BY t.created_at,t.job_id,t.asset_id,t.attempt`).all(installationId) as PendingMutation[];
  }
  markV2Dispatched(jobId: string, assetId: string, attempt: number, operationId: string): void { this.changeV2State(jobId, assetId, attempt, operationId, 'dispatched'); }
  markV2Ambiguous(jobId: string, assetId: string, attempt: number, operationId: string): void { this.changeV2State(jobId, assetId, attempt, operationId, 'ambiguous'); }
  markV2Safe(jobId: string, assetId: string, attempt: number, operationId: string): void { this.changeV2State(jobId, assetId, attempt, operationId, 'safe'); }
  private changeV2State(jobId: string, assetId: string, attempt: number, operationId: string, state: 'dispatched' | 'ambiguous' | 'safe'): void {
    const result = this.db.prepare('UPDATE attempts SET v2_state=? WHERE job_id=? AND asset_id=? AND attempt=? AND v2_operation_id=? AND v2_state!=?').run(state, jobId, assetId, attempt, operationId, 'safe');
    if (result.changes !== 1) throw Object.assign(new Error('v2 operation identity or state mismatch'), { code: 'V2_OPERATION_MISMATCH' });
  }
  getUsedReviewSessionIds(): ReadonlySet<string> {
    const rows = this.db.prepare(`SELECT json_extract(review_json, '$.sessionId') AS sessionId FROM reviews
      WHERE json_extract(review_json, '$.sessionId') IS NOT NULL`).all() as Array<{ sessionId: unknown }>;
    if (rows.some((row) => typeof row.sessionId !== 'string' || !row.sessionId)) throw new Error('persisted review session identity is invalid');
    return new Set(rows.map((row) => row.sessionId as string));
  }
  recordReview(record: ReviewRecord): void {
    this.db.transaction(() => {
      this.assertAttemptState(record.jobId, record.assetId, record.attempt, 'reviewing', 'reviewing');
      const sessionId = typeof record.payload === 'object' && record.payload !== null && 'sessionId' in record.payload
        ? (record.payload as { sessionId: unknown }).sessionId : null;
      if (sessionId !== null && (typeof sessionId !== 'string' || !sessionId || this.getUsedReviewSessionIds().has(sessionId))) throw new Error('review session identity invalid or reused');
      this.db.prepare('INSERT INTO reviews(review_id,job_id,asset_id,attempt,review_json,created_at) VALUES(?,?,?,?,?,?)').run(record.reviewId, record.jobId, record.assetId, record.attempt, JSON.stringify(record.payload), new Date().toISOString());
    })();
  }
  beginPublicationIntent(input: Omit<PublicationIntent, 'state'>): PublicationIntent {
    const intent: PublicationIntent = { ...input, state: 'prepared' };
    return this.db.transaction(() => {
      this.assertAttemptState(intent.jobId, intent.assetId, intent.attempt, 'readyToCommit', 'readyToCommit');
      const existing = this.getPublicationIntent(intent.jobId, intent.assetId, intent.attempt);
      if (existing) {
        if (existing.state === 'prepared' && Object.entries(input).every(([key, value]) => existing[key as keyof PublicationIntent] === value)) return existing;
        throw new Error('conflicting publication intent');
      }
      const job = this.db.prepare('SELECT spec_json AS spec,output_root_path AS root,output_root_identity AS identity FROM jobs WHERE job_id=?').get(intent.jobId) as { spec: string; root: string; identity: string } | undefined;
      const expected = `${intent.jobId}:${intent.assetId}:${intent.attempt}`;
      const confined = (path: string) => {
        const rel = relative(intent.outputRootPath, realpathWithExistingAncestor(path));
        return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
      };
      if (!job || job.root !== intent.outputRootPath || job.identity !== intent.outputRootIdentity
        || realpathSync(job.root) !== job.root || filesystemIdentity(job.root) !== job.identity
        || intent.transactionKey !== expected || !isAbsolute(intent.stagingDirectory) || !isAbsolute(intent.destinationPath)
        || !confined(intent.stagingDirectory) || !confined(intent.destinationPath) || intent.stagingDirectory === intent.destinationPath
        || [intent.manifestSha256, intent.decisionSha256, intent.reviewPolicySha256, intent.modelProvenanceSha256].some((value) => !/^[a-f0-9]{64}$/.test(value))) throw new Error('publication intent root, path, transaction or digest mismatch');
      const spec = JSON.parse(job.spec) as JobSpec;
      const review = this.db.prepare('SELECT review_json AS decision FROM reviews WHERE review_id=? AND job_id=? AND asset_id=? AND attempt=?').get(intent.reviewId, intent.jobId, intent.assetId, intent.attempt) as { decision: string } | undefined;
      const decision = ReviewDecisionSchema.safeParse(review ? JSON.parse(review.decision) : null);
      if (!decision.success || decision.data.verdict !== 'pass'
        || decision.data.variantChecks.some((item) => item.verdict !== 'pass')
        || decision.data.checks.some((item) => item.result !== 'pass')
        || decision.data.findings.some((item) => item.severity === 'critical' || item.severity === 'major')
        || decision.data.evidenceSha256 !== intent.manifestSha256 || sha256Json(decision.data) !== intent.decisionSha256
        || decision.data.reviewPolicySha256 !== intent.reviewPolicySha256 || spec.reviewPolicySha256 !== intent.reviewPolicySha256
        || sha256Json(decision.data.modelProvenance) !== intent.modelProvenanceSha256) throw new Error('publication intent review binding mismatch');
      const now = new Date().toISOString();
      this.db.prepare(`INSERT INTO publication_intents(job_id,asset_id,attempt,transaction_key,output_root_path,output_root_identity,staging_directory,destination_path,manifest_sha256,review_id,decision_sha256,review_policy_sha256,model_provenance_sha256,state,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(intent.jobId, intent.assetId, intent.attempt, intent.transactionKey, intent.outputRootPath, intent.outputRootIdentity,
        intent.stagingDirectory, intent.destinationPath, intent.manifestSha256, intent.reviewId, intent.decisionSha256, intent.reviewPolicySha256, intent.modelProvenanceSha256, 'prepared', now, now);
      return intent;
    })();
  }
  getPublicationIntent(jobId: string, assetId: string, attempt: number): PublicationIntent | null {
    return (this.db.prepare(`SELECT job_id AS jobId,asset_id AS assetId,attempt,transaction_key AS transactionKey,
      output_root_path AS outputRootPath,output_root_identity AS outputRootIdentity,staging_directory AS stagingDirectory,
      destination_path AS destinationPath,manifest_sha256 AS manifestSha256,review_id AS reviewId,decision_sha256 AS decisionSha256,
      review_policy_sha256 AS reviewPolicySha256,model_provenance_sha256 AS modelProvenanceSha256,state
      FROM publication_intents WHERE job_id=? AND asset_id=? AND attempt=?`).get(jobId, assetId, attempt) as PublicationIntent | undefined) ?? null;
  }
  listPendingPublicationIntents(): PublicationIntent[] {
    return this.db.prepare(`SELECT job_id AS jobId,asset_id AS assetId,attempt,transaction_key AS transactionKey,
      output_root_path AS outputRootPath,output_root_identity AS outputRootIdentity,staging_directory AS stagingDirectory,
      destination_path AS destinationPath,manifest_sha256 AS manifestSha256,review_id AS reviewId,decision_sha256 AS decisionSha256,
      review_policy_sha256 AS reviewPolicySha256,model_provenance_sha256 AS modelProvenanceSha256,state
      FROM publication_intents WHERE state IN ('prepared','renamed') ORDER BY created_at,job_id,asset_id,attempt`).all() as PublicationIntent[];
  }
  completePublicationIntent(input: PublicationIntent, record: PublicationRecord): void {
    this.db.transaction(() => {
      const current = this.getPublicationIntent(input.jobId, input.assetId, input.attempt);
      if (!current || Object.entries(input).some(([key, value]) => key !== 'state' && current[key as keyof PublicationIntent] !== value)) throw new Error('publication intent changed');
      if (record.jobId !== current.jobId || record.assetId !== current.assetId || record.attempt !== current.attempt
        || record.transactionKey !== current.transactionKey || record.path !== current.destinationPath) throw new Error('publication completion binding mismatch');
      if (current.state === 'committed') {
        const existing = this.db.prepare('SELECT publication_id AS id,path FROM publications WHERE transaction_key=?').get(current.transactionKey) as { id: string; path: string } | undefined;
        if (existing?.id === record.publicationId && existing.path === record.path) return;
        throw new Error('committed publication record mismatch');
      }
      if (current.state === 'quarantined') throw new Error('quarantined publication cannot complete');
      this.recordPublication(record);
      this.db.prepare('DELETE FROM pending_reviews WHERE job_id=? AND asset_id=? AND attempt=?').run(current.jobId, current.assetId, current.attempt);
      this.db.prepare(`UPDATE publication_intents SET state='committed',updated_at=? WHERE job_id=? AND asset_id=? AND attempt=?`).run(new Date().toISOString(), current.jobId, current.assetId, current.attempt);
      this.db.prepare(`UPDATE assets SET status='complete',error_json=NULL WHERE job_id=? AND asset_id=? AND attempt=? AND status='readyToCommit'`).run(current.jobId, current.assetId, current.attempt);
      this.db.prepare('UPDATE jobs SET state=?,updated_at=? WHERE job_id=?').run(this.deriveJobState(current.jobId), new Date().toISOString(), current.jobId);
    })();
  }
  markPublicationQuarantined(jobId: string, assetId: string, attempt: number): void {
    this.db.transaction(() => {
      const intent = this.getPublicationIntent(jobId, assetId, attempt);
      if (!intent || intent.state === 'committed') throw new Error('publication cannot be quarantined');
      if (intent.state === 'quarantined') return;
      this.db.prepare(`UPDATE publication_intents SET state='quarantined',updated_at=? WHERE job_id=? AND asset_id=? AND attempt=?`).run(new Date().toISOString(), jobId, assetId, attempt);
      this.db.prepare(`UPDATE assets SET status='blocked',error_json=? WHERE job_id=? AND asset_id=? AND attempt=? AND status='readyToCommit'`).run(JSON.stringify({
        code: 'PUBLICATION_QUARANTINED', category: 'review', message: 'committed publication failed reconciliation', retryable: false, evidencePaths: [],
      } satisfies DomainError), jobId, assetId, attempt);
      this.db.prepare('UPDATE jobs SET state=?,updated_at=? WHERE job_id=?').run(this.deriveJobState(jobId), new Date().toISOString(), jobId);
    })();
  }
  savePendingReview(input: PendingReview): void {
    const request = RenderRequestV2Schema.parse(input.request);
    const evidence = ReviewEvidenceSchema.parse(input.evidence);
    const manifest = EvidenceBundleManifestSchema.parse(input.manifest);
    if (evidence.schemaVersion !== 2) throw new Error('pending review requires V2 evidence');
    this.db.transaction(() => {
      const asset = this.row(input.jobId, input.assetId);
      if (asset.attempt !== input.attempt || asset.status !== 'reviewing') throw new Error('pending review is stale');
      const job = this.getJobSpec(input.jobId);
      const selected = job.assets.find((item) => item.assetId === input.assetId);
      const root = this.db.prepare('SELECT output_root_path AS path,output_root_identity AS identity FROM jobs WHERE job_id=?').get(input.jobId) as { path: string; identity: string };
      const attempt = this.db.prepare('SELECT v2_operation_id AS operationId,v2_staging_directory AS stagingDirectory FROM attempts WHERE job_id=? AND asset_id=? AND attempt=?').get(input.jobId, input.assetId, input.attempt) as { operationId: string | null; stagingDirectory: string | null } | undefined;
      const rel = relative(root.path, realpathWithExistingAncestor(input.stagingDirectory));
      const confined = rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
      if (!selected || root.path !== realpathSync(root.path) || root.identity !== filesystemIdentity(root.path)
        || !isAbsolute(input.stagingDirectory) || !confined || realpathSync(input.stagingDirectory) !== input.stagingDirectory
        || attempt?.operationId !== request.operationId || attempt.stagingDirectory !== input.stagingDirectory
        || request.stagingDirectory !== input.stagingDirectory || request.jobId !== input.jobId || request.asset.assetId !== input.assetId
        || request.attempt !== input.attempt || request.asset.source.sha256 !== selected.source.sha256
        || request.asset.sourceBytes !== selected.sourceBytes || request.profile.profileSha256 !== job.profile.profileSha256
        || evidence.jobId !== input.jobId || evidence.assetId !== input.assetId || evidence.attempt !== input.attempt
        || evidence.operationId !== request.operationId || evidence.sourceSha256 !== selected.source.sha256
        || evidence.profileSha256 !== job.profile.profileSha256 || evidence.toolSchemaSha256 !== job.profile.toolSchemaSha256
        || manifest.jobId !== input.jobId || manifest.assetId !== input.assetId || manifest.attempt !== input.attempt
        || input.reviewPolicySha256 !== job.reviewPolicySha256
        || [input.plannerProfileSha256, input.reviewerProfileSha256].some((value) => !/^[a-f0-9]{64}$/.test(value))
        || !input.qa.artifactChecksPassed || input.qa.bindings.jobId !== input.jobId || input.qa.bindings.assetId !== input.assetId
        || input.qa.bindings.attempt !== input.attempt || input.qa.bindings.sourceSha256 !== selected.source.sha256
        || input.qa.bindings.profileSha256 !== job.profile.profileSha256 || input.qa.bindings.toolSchemaSha256 !== job.profile.toolSchemaSha256
        || input.qa.bindings.reviewPolicySha256 !== job.reviewPolicySha256 || input.qa.artifacts.length !== 3
        || evidence.artifacts.some((item, index) => item.variantId !== input.qa.artifacts[index]?.variantId
          || item.path !== input.qa.artifacts[index]?.path || item.sha256 !== input.qa.artifacts[index]?.sha256)
        || evidence.artifacts.some((item) => !manifest.files.some((file) => file.relativePath === item.path && file.sha256 === item.sha256)))
        throw new Error('pending review evidence or current-attempt binding mismatch');
      const existing = this.getPendingReview(input.jobId, input.assetId, input.attempt);
      if (existing) {
        if (JSON.stringify(existing) === JSON.stringify(input)) return;
        throw new Error('conflicting pending review');
      }
      this.db.prepare(`INSERT INTO pending_reviews(job_id,asset_id,attempt,staging_directory,output_root_path,output_root_identity,
        request_json,evidence_json,manifest_json,qa_json,manifest_sha256,source_sha256,profile_sha256,tool_schema_sha256,
        review_policy_sha256,planner_profile_id,reviewer_profile_id,planner_profile_sha256,reviewer_profile_sha256,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(input.jobId, input.assetId, input.attempt, input.stagingDirectory,
        root.path, root.identity, JSON.stringify(request), JSON.stringify(evidence), JSON.stringify(manifest), JSON.stringify(input.qa),
        bundleDigest(manifest), selected.source.sha256, job.profile.profileSha256, job.profile.toolSchemaSha256,
        job.reviewPolicySha256, job.modelProfileId, job.reviewerModelProfileId, input.plannerProfileSha256,
        input.reviewerProfileSha256, new Date().toISOString());
    })();
  }
  getPendingReview(jobId: string, assetId: string, attempt: number): PendingReview | null {
    const row = this.db.prepare(`SELECT staging_directory AS stagingDirectory,request_json AS request,evidence_json AS evidence,
      manifest_json AS manifest,qa_json AS qa,review_policy_sha256 AS reviewPolicySha256,
      planner_profile_sha256 AS plannerProfileSha256,reviewer_profile_sha256 AS reviewerProfileSha256,
      planner_profile_id AS plannerProfileId,reviewer_profile_id AS reviewerProfileId,
      output_root_path AS outputRootPath,output_root_identity AS outputRootIdentity,
      manifest_sha256 AS manifestSha256,source_sha256 AS sourceSha256,profile_sha256 AS profileSha256,
      tool_schema_sha256 AS toolSchemaSha256
      FROM pending_reviews WHERE job_id=? AND asset_id=? AND attempt=?`).get(jobId, assetId, attempt) as {
      stagingDirectory: string; request: string; evidence: string; manifest: string; qa: string;
      reviewPolicySha256: string; plannerProfileSha256: string; reviewerProfileSha256: string;
      plannerProfileId: string; reviewerProfileId: string; outputRootPath: string; outputRootIdentity: string;
      manifestSha256: string; sourceSha256: string; profileSha256: string; toolSchemaSha256: string
    } | undefined;
    if (!row) return null;
    const asset = this.row(jobId, assetId);
    if (asset.attempt !== attempt || asset.status !== 'reviewing') throw new Error('pending review is stale');
    const job = this.getJobSpec(jobId);
    const source = job.assets.find((item) => item.assetId === assetId);
    const root = this.db.prepare('SELECT output_root_path AS path,output_root_identity AS identity FROM jobs WHERE job_id=?').get(jobId) as { path: string; identity: string };
    const manifest = EvidenceBundleManifestSchema.parse(JSON.parse(row.manifest));
    let stagingBound = false;
    try {
      const rel = relative(root.path, realpathSync(row.stagingDirectory));
      stagingBound = rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
        && realpathSync(row.stagingDirectory) === row.stagingDirectory;
    } catch { stagingBound = false; }
    if (!source || row.plannerProfileId !== job.modelProfileId || row.reviewerProfileId !== job.reviewerModelProfileId
      || row.sourceSha256 !== source.source.sha256 || row.profileSha256 !== job.profile.profileSha256
      || row.toolSchemaSha256 !== job.profile.toolSchemaSha256 || row.reviewPolicySha256 !== job.reviewPolicySha256
      || row.outputRootPath !== root.path || row.outputRootIdentity !== root.identity
      || root.path !== realpathSync(root.path) || root.identity !== filesystemIdentity(root.path)
      || row.manifestSha256 !== bundleDigest(manifest) || !stagingBound) throw new Error('pending review selected model, staging or job binding changed');
    return { jobId, assetId, attempt: attempt as 1 | 2, stagingDirectory: row.stagingDirectory,
      request: RenderRequestV2Schema.parse(JSON.parse(row.request)), evidence: ReviewEvidenceSchema.parse(JSON.parse(row.evidence)),
      manifest, qa: JSON.parse(row.qa) as ArtifactQaResult,
      reviewPolicySha256: row.reviewPolicySha256, plannerProfileSha256: row.plannerProfileSha256,
      reviewerProfileSha256: row.reviewerProfileSha256 };
  }
  listPendingReviews(): PendingReview[] {
    const keys = this.db.prepare(`SELECT p.job_id AS jobId,p.asset_id AS assetId,p.attempt
      FROM pending_reviews p JOIN assets a ON a.job_id=p.job_id AND a.asset_id=p.asset_id
      WHERE a.attempt=p.attempt AND a.status='reviewing' ORDER BY p.created_at,p.job_id,p.asset_id`).all() as Array<{ jobId: string; assetId: string; attempt: number }>;
    return keys.map((key) => this.getPendingReview(key.jobId, key.assetId, key.attempt)!);
  }
  clearPendingReview(jobId: string, assetId: string, attempt: number): void {
    const asset = this.row(jobId, assetId);
    if (asset.attempt !== attempt || !['blocked', 'failed', 'cancelled', 'complete'].includes(asset.status)) throw new Error('active pending review cannot be cleared');
    this.db.prepare('DELETE FROM pending_reviews WHERE job_id=? AND asset_id=? AND attempt=?').run(jobId, assetId, attempt);
  }
  createVisualReviewRequest(request: VisualReviewRequest, context: { plannerProfileSha256: string; reviewerProfileSha256: string; expiresAt: string }): void {
    const parsed = VisualReviewRequestSchema.parse(request);
    if ([context.plannerProfileSha256, context.reviewerProfileSha256].some((value) => !/^[a-f0-9]{64}$/.test(value))
      || !Number.isFinite(Date.parse(context.expiresAt))) throw new Error('invalid visual request context');
    this.db.transaction(() => {
      const asset = this.row(parsed.jobId, parsed.assetId);
      if (asset.attempt !== parsed.attempt || !['reviewing', 'readyToCommit'].includes(asset.status)) throw new Error('visual request is stale');
      const job = this.getJobSpec(parsed.jobId);
      const source = job.assets.find((item) => item.assetId === parsed.assetId);
      if (!source || parsed.sourceSha256 !== source.source.sha256 || parsed.profileSha256 !== job.profile.profileSha256
        || parsed.toolSchemaSha256 !== job.profile.toolSchemaSha256 || parsed.reviewPolicySha256 !== job.reviewPolicySha256) throw new Error('visual request job binding mismatch');
      const existing = this.db.prepare('SELECT request_id AS id,request_json AS json,planner_profile_id AS plannerId,reviewer_profile_id AS reviewerId,planner_profile_sha256 AS plannerSha,reviewer_profile_sha256 AS reviewerSha,expires_at AS expires FROM visual_review_requests WHERE job_id=? AND asset_id=? AND attempt=?').get(parsed.jobId, parsed.assetId, parsed.attempt) as { id: string; json: string; plannerId: string; reviewerId: string; plannerSha: string; reviewerSha: string; expires: string } | undefined;
      if (existing) {
        if (existing.id === parsed.requestId && existing.json === JSON.stringify(parsed)
          && existing.plannerId === job.modelProfileId && existing.reviewerId === job.reviewerModelProfileId
          && existing.plannerSha === context.plannerProfileSha256 && existing.reviewerSha === context.reviewerProfileSha256
          && existing.expires === context.expiresAt) return;
        throw new Error('conflicting visual request for current attempt');
      }
      this.db.prepare(`INSERT INTO visual_review_requests(request_id,job_id,asset_id,attempt,request_json,planner_profile_id,reviewer_profile_id,planner_profile_sha256,reviewer_profile_sha256,expires_at,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(parsed.requestId, parsed.jobId, parsed.assetId, parsed.attempt, JSON.stringify(parsed), job.modelProfileId,
        job.reviewerModelProfileId, context.plannerProfileSha256, context.reviewerProfileSha256, context.expiresAt, new Date().toISOString());
    })();
  }
  getVisualReviewRequest(requestId: string): VisualReviewRequest | null {
    const row = this.db.prepare('SELECT request_json AS json FROM visual_review_requests WHERE request_id=?').get(requestId) as { json: string } | undefined;
    return row ? VisualReviewRequestSchema.parse(JSON.parse(row.json)) : null;
  }
  getVisualReviewRequestBinding(requestId: string): { plannerModelProfileId: string; reviewerModelProfileId: string; plannerProfileSha256: string; reviewerProfileSha256: string; expiresAt: string } | null {
    return (this.db.prepare(`SELECT planner_profile_id AS plannerModelProfileId,reviewer_profile_id AS reviewerModelProfileId,
      planner_profile_sha256 AS plannerProfileSha256,reviewer_profile_sha256 AS reviewerProfileSha256,expires_at AS expiresAt
      FROM visual_review_requests WHERE request_id=?`).get(requestId) as {
      plannerModelProfileId: string; reviewerModelProfileId: string; plannerProfileSha256: string; reviewerProfileSha256: string; expiresAt: string
    } | undefined) ?? null;
  }
  getCurrentVisualReviewRequest(jobId: string, assetId: string): VisualReviewRequest | null {
    const asset = this.row(jobId, assetId);
    if (!['reviewing', 'readyToCommit'].includes(asset.status)) return null;
    const row = this.db.prepare('SELECT request_json AS json FROM visual_review_requests WHERE job_id=? AND asset_id=? AND attempt=?').get(jobId, assetId, asset.attempt) as { json: string } | undefined;
    return row ? VisualReviewRequestSchema.parse(JSON.parse(row.json)) : null;
  }
  consumeVisualReviewRequest(attestation: HumanVisualAttestationV1, attestationFile: { relativePath: string; sha256: string }): VisualAttestationReceipt {
    const parsed = HumanVisualAttestationV1Schema.parse(attestation);
    if (!RelativePathSchema.safeParse(attestationFile.relativePath).success || attestationFile.sha256 !== sha256Json(parsed)) throw new Error('attestation file binding mismatch');
    return this.db.transaction(() => {
      const request = parsed.request;
      const row = this.db.prepare(`SELECT request_json AS json,planner_profile_id AS plannerId,reviewer_profile_id AS reviewerId,
        planner_profile_sha256 AS plannerSha,reviewer_profile_sha256 AS reviewerSha,expires_at AS expires,
        attestation_json AS attestation,attestation_relative_path AS attestationPath,attestation_sha256 AS attestationSha
        FROM visual_review_requests WHERE request_id=?`).get(request.requestId) as { json: string; plannerId: string; reviewerId: string; plannerSha: string; reviewerSha: string; expires: string; attestation: string | null; attestationPath: string | null; attestationSha: string | null } | undefined;
      if (!row) throw new Error('unknown visual review request');
      const asset = this.row(request.jobId, request.assetId);
      if (asset.attempt !== request.attempt || !['reviewing', 'readyToCommit'].includes(asset.status)) throw new Error('stale visual review request');
      const stored = VisualReviewRequestSchema.parse(JSON.parse(row.json));
      const job = this.getJobSpec(request.jobId);
      if (sha256Json(stored) !== sha256Json(request) || row.expires !== parsed.expiresAt
        || row.plannerId !== job.modelProfileId || row.reviewerId !== job.reviewerModelProfileId
        || !/^[a-f0-9]{64}$/.test(row.plannerSha) || !/^[a-f0-9]{64}$/.test(row.reviewerSha)
        || stored.reviewPolicySha256 !== job.reviewPolicySha256 || stored.profileSha256 !== job.profile.profileSha256
        || stored.toolSchemaSha256 !== job.profile.toolSchemaSha256
        || stored.sourceSha256 !== job.assets.find((item) => item.assetId === stored.assetId)?.source.sha256) throw new Error('visual review binding changed');
      if (row.attestation) {
        if (row.attestation !== JSON.stringify(parsed) || row.attestationPath !== attestationFile.relativePath || row.attestationSha !== attestationFile.sha256) throw new Error('conflicting visual attestation replay');
        return this.getConsumedVisualAttestation(request.jobId, request.assetId, request.attempt)!;
      }
      if (Date.now() >= Date.parse(row.expires)) throw new Error('visual review request expired');
      this.db.prepare('UPDATE visual_review_requests SET attestation_json=?,attestation_relative_path=?,attestation_sha256=? WHERE request_id=? AND attestation_json IS NULL').run(JSON.stringify(parsed), attestationFile.relativePath, attestationFile.sha256, request.requestId);
      return this.getConsumedVisualAttestation(request.jobId, request.assetId, request.attempt)!;
    })();
  }
  getConsumedVisualAttestation(jobId: string, assetId: string, attempt: number): VisualAttestationReceipt | null {
    const row = this.db.prepare(`SELECT attestation_json AS json,attestation_relative_path AS path,attestation_sha256 AS sha
      FROM visual_review_requests WHERE job_id=? AND asset_id=? AND attempt=?`).get(jobId, assetId, attempt) as { json: string | null; path: string | null; sha: string | null } | undefined;
    if (!row?.json || !row.path || !row.sha) return null;
    const value = HumanVisualAttestationV1Schema.parse(JSON.parse(row.json));
    return { request: value.request, decision: value.decision, operatorIdentity: value.operatorIdentity,
      consumed: true, consumedAt: value.consumedAt, expiresAt: value.expiresAt,
      attestationRelativePath: row.path, attestationSha256: row.sha };
  }
  recordPublication(record: PublicationRecord): void {
    this.db.transaction(() => {
      this.assertAttemptState(record.jobId, record.assetId, record.attempt, 'readyToCommit', 'readyToCommit');
      const job = this.db.prepare('SELECT output_root_path AS root,output_root_identity AS identity FROM jobs WHERE job_id=?').get(record.jobId) as { root: string | null; identity: string | null } | undefined;
      const expected = `${record.jobId}:${record.assetId}:${record.attempt}`;
      let confined = false;
      try { const root = realpathSync(job?.root ?? ''); const candidate = realpathWithExistingAncestor(record.path); const rel = relative(root, candidate); confined = rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); } catch { confined = false; }
      if (!job?.root || !job.identity || filesystemIdentity(job.root) !== job.identity || record.transactionKey !== expected || !confined) throw Object.assign(new Error('publication is outside trusted output root or has invalid transaction identity'), { code: 'PUBLICATION_BINDING_MISMATCH' });
      this.db.prepare('INSERT INTO publications(publication_id,job_id,asset_id,attempt,transaction_key,path,manifest_json,created_at) VALUES(?,?,?,?,?,?,?,?)').run(record.publicationId, record.jobId, record.assetId, record.attempt, expected, record.path, record.manifest === undefined ? null : JSON.stringify(record.manifest), new Date().toISOString());
    })();
  }
  recordQualification(record: QualificationRecord): void {
    const profile = TemplateProfileSchema.safeParse(record.profile);
    if (!profile.success || profile.data.profileId !== record.profileId || profile.data.profileSha256 !== record.profileSha256 || sha256Json(profile.data, { excludeKeys: ['profileSha256'] }) !== record.profileSha256) throw Object.assign(new Error('qualification profile digest mismatch'), { code: 'QUALIFICATION_MISMATCH' });
    this.db.prepare('INSERT INTO qualifications(qualification_id,profile_id,profile_sha256,evidence_json,profile_json,created_at) VALUES(?,?,?,?,?,?)').run(record.qualificationId, record.profileId, record.profileSha256, JSON.stringify(record.evidence), JSON.stringify(profile.data), new Date().toISOString());
  }
  getQualification(qualificationId: string): QualificationRecord | null { const row = this.db.prepare('SELECT qualification_id AS qualificationId,profile_id AS profileId,profile_sha256 AS profileSha256,evidence_json,profile_json FROM qualifications WHERE qualification_id=?').get(qualificationId) as ({ qualificationId: string; profileId: string; profileSha256: string; evidence_json: string; profile_json: string | null } | undefined); if (!row || !row.profile_json) return null; try { const profile = TemplateProfileSchema.safeParse(JSON.parse(row.profile_json)); if (!profile.success || profile.data.profileId !== row.profileId || profile.data.profileSha256 !== row.profileSha256 || sha256Json(profile.data, { excludeKeys: ['profileSha256'] }) !== row.profileSha256) throw new Error('invalid persisted qualification profile'); return { qualificationId: row.qualificationId, profileId: row.profileId, profileSha256: row.profileSha256, evidence: JSON.parse(row.evidence_json), profile: profile.data }; } catch { throw Object.assign(new Error('persisted qualification JSON is malformed or invalid'), { code: 'QUALIFICATION_MISMATCH' }); } }

  requestPause(jobId: string): void { this.db.prepare("UPDATE jobs SET state='pausing',requested_control='pause',updated_at=? WHERE job_id=? AND state IN ('ready','running')").run(new Date().toISOString(), jobId); }
  pause(jobId: string): void { this.requestPause(jobId); }
  controlState(jobId: string): string | null { return this.jobControl(jobId); }
  acknowledgePause(jobId: string): void { this.db.transaction(() => { const derived = this.deriveJobState(jobId); const state = ['completed', 'failed', 'blocked', 'cancelled'].includes(derived) ? derived : 'paused'; this.db.prepare("UPDATE jobs SET state=?,requested_control=NULL,updated_at=? WHERE job_id=? AND requested_control='pause'").run(state, new Date().toISOString(), jobId); })(); }
  resume(jobId: string): void { this.db.transaction(() => { const derived = this.deriveJobState(jobId); const state = ['completed', 'failed', 'blocked', 'cancelled'].includes(derived) ? derived : 'running'; this.db.prepare("UPDATE jobs SET state=?,requested_control=NULL,updated_at=? WHERE job_id=? AND state IN ('pausing','paused')").run(state, new Date().toISOString(), jobId); })(); }
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
      let parsedSpec: unknown;
      try { parsedSpec = JSON.parse(source.spec_json); } catch { throw new Error('persisted job specification is malformed'); }
      const validatedSpec = validateJobSpec(parsedSpec);
      if (!validatedSpec.success) throw new Error('persisted job specification is invalid');
      const spec = validatedSpec.data;
      const successor: JobSpec = { ...spec, jobId: randomUUID(), assets: spec.assets.filter((asset) => chosen.includes(asset.assetId)) };
      const root = this.db.prepare('SELECT output_root_path AS canonicalRoot,output_root_identity AS canonicalRootIdentity FROM jobs WHERE job_id=?').get(jobId) as { canonicalRoot: string | null; canonicalRootIdentity: string | null } | undefined;
      if (!root?.canonicalRoot || !root.canonicalRootIdentity) throw Object.assign(new Error('trusted output-root binding is required'), { code: 'OUTPUT_ROOT_BINDING_REQUIRED' });
      this.createJob(successor, jobId, { rootId: successor.outputRootId, canonicalRoot: root.canonicalRoot, canonicalRootIdentity: root.canonicalRootIdentity });
      return { jobId: successor.jobId };
    })();
  }
  getJobSpec(jobId: string): JobSpec { const row = this.db.prepare('SELECT spec_json FROM jobs WHERE job_id=?').get(jobId) as { spec_json: string } | undefined; if (!row) throw new Error(`unknown job: ${jobId}`); try { const parsed = validateJobSpec(JSON.parse(row.spec_json)); if (!parsed.success) throw new Error('invalid persisted job specification'); return parsed.data; } catch { throw new Error('persisted job specification is malformed or invalid'); } }
  listPublications(jobId: string): Array<{ assetId: string; path: string; transactionKey: string }> { return this.db.prepare('SELECT asset_id AS assetId,path,transaction_key AS transactionKey FROM publications WHERE job_id=? ORDER BY asset_id').all(jobId) as Array<{ assetId: string; path: string; transactionKey: string }>; }
}
