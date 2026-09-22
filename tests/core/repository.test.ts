import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { mkdirSync, realpathSync, renameSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { JobRepository } from '@ne-psd/core';
import type { OutputRootBinding } from '@ne-psd/core';
import { sha256Json } from '@ne-psd/contracts';
import type { JobSpec } from '@ne-psd/contracts';

const hash = 'a'.repeat(64);
const selector = { documentRoute: [], layerPath: [{ name: 'target', kind: 'smartObject' as const, fingerprint: 'f' }] };
const rootBinding = (rootId = 'out'): OutputRootBinding => { const rawRoot = `/tmp/ne-psd-${rootId}`; mkdirSync(rawRoot, { recursive: true }); const canonicalRoot = realpathSync(rawRoot); const info = statSync(canonicalRoot); return { rootId, canonicalRoot, canonicalRootIdentity: createHash('sha256').update(`${canonicalRoot}|${info.dev}|${info.ino}`).digest('hex') }; };
const spec = (jobId = 'job-1'): JobSpec => {
 const value: JobSpec = ({
  schemaVersion: 1, jobId, outputRootId: 'out', modelProfileId: 'brain', reviewerModelProfileId: 'reviewer', reviewPolicySha256: hash,
  trigger: 'interactive', maxAttempts: 2,
  profile: { schemaVersion: 1, profileId: 'profile', template: { rootId: 'templates', relativePath: 'template.psd', sha256: hash }, profileSha256: hash, qualificationId: 'qualification', backendId: 'alisaitteke', toolSchemaSha256: hash, targets: [{ target: selector, reference: selector, input: null }], fitMode: 'cover', output: { format: 'png', quality: 90, colorSpace: 'sRGB', width: 10, height: 10 }, variants: [{ id: '1', group: selector }, { id: '2', group: { ...selector, layerPath: [{ ...selector.layerPath[0]!, name: 'v2' }] } }, { id: '3', group: { ...selector, layerPath: [{ ...selector.layerPath[0]!, name: 'v3' }] } }] },
  assets: [{ assetId: 'asset-1', source: { rootId: 'input', relativePath: 'a.png', sha256: hash }, sourceBytes: 1 }],
 });
 value.profile.profileSha256 = sha256Json(value.profile, { excludeKeys: ['profileSha256'] });
 return value;
};

describe('durable repository', () => {
  const createQualified = (repository: JobRepository, value: JobSpec) => { repository.recordQualification({ qualificationId: value.profile.qualificationId, profileId: value.profile.profileId, profileSha256: value.profile.profileSha256, evidence: { source: 'test' }, profile: value.profile }); repository.createJob(value, null, rootBinding(value.outputRootId)); };
  it('migrates, reopens, snapshots from rows, and increments event sequence per job', async () => {
    expect(existsSync(join(process.cwd(), 'packages/core/dist/migrations/001-initial.sql'))).toBe(true);
    const db = join(await mkdtemp(join(tmpdir(), 'ne-psd-db-')), 'state.sqlite');
    const first = new JobRepository(db);
    createQualified(first, spec());
    first.transition('job-1', 'asset-1', 'rendering');
    const event = first.appendEvent('job-1', 'assetStatus');
    expect(event.sequence).toBe(1);
    expect(first.snapshot('job-1').assets[0]!.status).toBe('rendering');
    first.close();
    const reopened = new JobRepository(db);
    expect(reopened.snapshot('job-1').assets[0]!.status).toBe('rendering');
    expect(reopened.snapshot('job-1').complete).toBe(0);
    expect(reopened.appendEvent('job-1', 'snapshot').sequence).toBe(2);
    reopened.close();
  });

  it('persists attempts, reviews, publications, and qualifications with transaction uniqueness', async () => {
    const db = join(await mkdtemp(join(tmpdir(), 'ne-psd-records-')), 'state.sqlite');
    const repository = new JobRepository(db);
    createQualified(repository, spec('records'));
    repository.transition('records', 'asset-1', 'rendering');
    expect(repository.attempts('records', 'asset-1')).toHaveLength(1);
    repository.recordReview({ reviewId: 'review-1', jobId: 'records', assetId: 'asset-1', attempt: 1, payload: { verdict: 'blocked' } });
    repository.recordPublication({ publicationId: 'publication-1', jobId: 'records', assetId: 'asset-1', attempt: 1, transactionKey: 'records:asset-1:1', path: '/tmp/ne-psd-out/published' });
    const extra = spec('extra').profile; extra.profileId = 'profile-2'; extra.qualificationId = 'qualification-1'; extra.profileSha256 = sha256Json(extra, { excludeKeys: ['profileSha256'] });
    repository.recordQualification({ qualificationId: 'qualification-1', profileId: 'profile-2', profileSha256: extra.profileSha256, evidence: { path: 'evidence' }, profile: extra });
    expect(repository.getQualification('qualification-1')?.profileSha256).toBe(extra.profileSha256);
    expect(() => repository.recordPublication({ publicationId: 'publication-2', jobId: 'records', assetId: 'asset-1', attempt: 1, transactionKey: 'records:asset-1:1', path: '/tmp/ne-psd-out/other' })).toThrow();
    repository.close();
  });

  it('binds reviews and publications to an existing attempt across reopen', async () => {
    const db = join(await mkdtemp(join(tmpdir(), 'ne-psd-attempt-integrity-')), 'state.sqlite');
    const first = new JobRepository(db);
    createQualified(first, spec('attempt-integrity'));
    first.transition('attempt-integrity', 'asset-1', 'rendering');
    expect(() => first.recordReview({ reviewId: 'review-missing-attempt', jobId: 'attempt-integrity', assetId: 'asset-1', attempt: 2, payload: { verdict: 'blocked' } })).toThrow();
    expect(() => first.recordPublication({ publicationId: 'publication-missing-attempt', jobId: 'attempt-integrity', assetId: 'asset-1', attempt: 2, transactionKey: 'attempt-integrity:asset-1:2', path: '/tmp/ne-psd-out/other' })).toThrow();
    first.close();

    const reopened = new JobRepository(db);
    expect(() => reopened.recordReview({ reviewId: 'review-wrong-asset', jobId: 'attempt-integrity', assetId: 'missing-asset', attempt: 1, payload: { verdict: 'blocked' } })).toThrow();
    expect(() => reopened.recordPublication({ publicationId: 'publication-wrong-asset', jobId: 'attempt-integrity', assetId: 'missing-asset', attempt: 1, transactionKey: 'attempt-integrity:missing-asset:1', path: '/tmp/ne-psd-out/other' })).toThrow();
    reopened.recordReview({ reviewId: 'review-valid', jobId: 'attempt-integrity', assetId: 'asset-1', attempt: 1, payload: { verdict: 'blocked' } });
    reopened.recordPublication({ publicationId: 'publication-valid', jobId: 'attempt-integrity', assetId: 'asset-1', attempt: 1, transactionKey: 'attempt-integrity:asset-1:1', path: '/tmp/ne-psd-out/published' });
    reopened.close();

    const reopenedAgain = new JobRepository(db);
    expect(() => reopenedAgain.recordPublication({ publicationId: 'publication-duplicate-transaction', jobId: 'attempt-integrity', assetId: 'asset-1', attempt: 1, transactionKey: 'attempt-integrity:asset-1:1', path: '/tmp/ne-psd-out/other' })).toThrow();
    reopenedAgain.close();
  });

  it('upgrades the legacy attempt foreign keys without losing persisted rows', async () => {
    const db = join(await mkdtemp(join(tmpdir(), 'ne-psd-legacy-migration-')), 'state.sqlite');
    const legacy = new Database(db);
    legacy.pragma('foreign_keys = ON');
    legacy.exec(`
      CREATE TABLE jobs (job_id TEXT PRIMARY KEY, spec_json TEXT NOT NULL, state TEXT NOT NULL, schema_version INTEGER NOT NULL, contract_version INTEGER NOT NULL, parent_job_id TEXT, requested_control TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE assets (asset_id TEXT NOT NULL, job_id TEXT NOT NULL, source_json TEXT NOT NULL, status TEXT NOT NULL, attempt INTEGER NOT NULL, error_json TEXT, PRIMARY KEY(job_id, asset_id), FOREIGN KEY(job_id) REFERENCES jobs(job_id) ON DELETE CASCADE);
      CREATE TABLE attempts (job_id TEXT NOT NULL, asset_id TEXT NOT NULL, attempt INTEGER NOT NULL, transaction_key TEXT NOT NULL UNIQUE, state TEXT NOT NULL, evidence_json TEXT, created_at TEXT NOT NULL, PRIMARY KEY(job_id, asset_id, attempt), FOREIGN KEY(job_id, asset_id) REFERENCES assets(job_id, asset_id) ON DELETE CASCADE);
      CREATE TABLE reviews (review_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, asset_id TEXT NOT NULL, attempt INTEGER NOT NULL, review_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(job_id, asset_id, attempt), FOREIGN KEY(job_id, asset_id) REFERENCES assets(job_id, asset_id) ON DELETE CASCADE);
      CREATE TABLE publications (publication_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, asset_id TEXT NOT NULL, attempt INTEGER NOT NULL, transaction_key TEXT NOT NULL UNIQUE, path TEXT NOT NULL, manifest_json TEXT, created_at TEXT NOT NULL, FOREIGN KEY(job_id, asset_id) REFERENCES assets(job_id, asset_id) ON DELETE CASCADE);
      CREATE TABLE qualifications (qualification_id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, profile_sha256 TEXT NOT NULL, evidence_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(profile_id, profile_sha256));
    `);
    const value = spec('legacy');
    const now = new Date().toISOString();
    legacy.prepare('INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?)').run(value.jobId, JSON.stringify(value), 'running', 1, 1, null, null, now, now);
    legacy.prepare('INSERT INTO assets VALUES (?,?,?,?,?,?)').run('asset-1', value.jobId, JSON.stringify(value.assets[0]), 'rendering', 1, null);
    legacy.prepare('INSERT INTO attempts VALUES (?,?,?,?,?,?,?)').run(value.jobId, 'asset-1', 1, 'legacy-tx', 'rendering', null, now);
    legacy.prepare('INSERT INTO qualifications VALUES (?,?,?,?,?)').run('qualification', 'profile', hash, '{"source":"legacy"}', now);
    legacy.close();

    const reopened = new JobRepository(db);
    expect(reopened.snapshot('legacy').assets[0]!.status).toBe('rendering');
    expect(() => reopened.recordReview({ reviewId: 'legacy-invalid-review', jobId: 'legacy', assetId: 'asset-1', attempt: 2, payload: { verdict: 'blocked' } })).toThrow();
    expect(() => reopened.recordPublication({ publicationId: 'legacy-invalid-publication', jobId: 'legacy', assetId: 'asset-1', attempt: 2, transactionKey: 'legacy-invalid-tx', path: '/tmp/other' })).toThrow();
    reopened.recordReview({ reviewId: 'legacy-review', jobId: 'legacy', assetId: 'asset-1', attempt: 1, payload: { verdict: 'blocked' } });
    expect(() => reopened.recordPublication({ publicationId: 'legacy-publication', jobId: 'legacy', assetId: 'asset-1', attempt: 1, transactionKey: 'legacy:asset-1:1', path: '/tmp/ne-psd-out/published' })).toThrow(/output root|binding/i);
    reopened.close();

    const reopenedAgain = new JobRepository(db);
    expect(() => reopenedAgain.recordPublication({ publicationId: 'legacy-duplicate', jobId: 'legacy', assetId: 'asset-1', attempt: 1, transactionKey: 'legacy-pub-tx', path: '/tmp/other' })).toThrow();
    reopenedAgain.close();
  });

  it('keeps pause and cancel requests pending until safe-boundary acknowledgement', async () => {
    const db = join(await mkdtemp(join(tmpdir(), 'ne-psd-control-')), 'state.sqlite');
    const repository = new JobRepository(db);
    createQualified(repository, spec('control'));
    repository.transition('control', 'asset-1', 'rendering');
    repository.pause('control');
    expect(repository.controlState('control')).toBe('pause');
    repository.transition('control', 'asset-1', 'reviewing');
    expect(repository.snapshot('control').assets[0]!.status).toBe('reviewing');
    repository.acknowledgePause('control');
    expect(repository.snapshot('control').state).toBe('paused');
    repository.requestCancel('control');
    expect(repository.controlState('control')).toBe('cancel');
    repository.acknowledgeCancel('control');
    expect(repository.snapshot('control').assets[0]!.status).toBe('cancelled');
    repository.close();
  });

  it('uses failed then blocked precedence for mixed terminal assets', async () => {
    const db = join(await mkdtemp(join(tmpdir(), 'ne-psd-precedence-')), 'state.sqlite');
    const repository = new JobRepository(db);
    const job = spec('precedence');
    job.assets = [job.assets[0]!, { ...job.assets[0]!, assetId: 'asset-2', source: { ...job.assets[0]!.source, relativePath: 'b.png' } }];
    createQualified(repository, job);
    repository.transition('precedence', 'asset-1', 'rendering'); repository.transition('precedence', 'asset-1', 'failed', { code: 'FAILED', category: 'transient', message: 'failed', retryable: true, evidencePaths: [] });
    repository.transition('precedence', 'asset-2', 'rendering'); repository.transition('precedence', 'asset-2', 'blocked', { code: 'BLOCKED', category: 'review', message: 'blocked', retryable: false, evidencePaths: [] });
    expect(repository.snapshot('precedence').state).toBe('blocked');
    repository.close();
  });

  it('rejects a third automatic attempt before inserting attempt state', async () => {
    const db = join(await mkdtemp(join(tmpdir(), 'ne-psd-attempt-ceiling-')), 'state.sqlite');
    const repository = new JobRepository(db);
    createQualified(repository, spec('attempt-ceiling'));
    repository.transition('attempt-ceiling', 'asset-1', 'rendering');
    repository.transition('attempt-ceiling', 'asset-1', 'failed', { code: 'FAILED-1', category: 'transient', message: 'failed', retryable: true, evidencePaths: [] });
    repository.transition('attempt-ceiling', 'asset-1', 'queued');
    repository.transition('attempt-ceiling', 'asset-1', 'rendering');
    repository.transition('attempt-ceiling', 'asset-1', 'failed', { code: 'FAILED-2', category: 'transient', message: 'failed', retryable: true, evidencePaths: [] });
    repository.transition('attempt-ceiling', 'asset-1', 'queued');
    expect(() => repository.transition('attempt-ceiling', 'asset-1', 'rendering')).toThrowError(/attempt limit/i);
    expect(repository.attempts('attempt-ceiling', 'asset-1')).toHaveLength(2);
    repository.close();
  });

  it('does not expose ready for complete plus failed terminal assets', async () => {
    const db = join(await mkdtemp(join(tmpdir(), 'ne-psd-mixed-terminal-')), 'state.sqlite');
    const repository = new JobRepository(db);
    const job = spec('mixed-terminal');
    job.assets = [job.assets[0]!, { ...job.assets[0]!, assetId: 'asset-2', source: { ...job.assets[0]!.source, relativePath: 'b.png' } }];
    createQualified(repository, job);
    repository.transition('mixed-terminal', 'asset-1', 'rendering'); repository.transition('mixed-terminal', 'asset-1', 'reviewing'); repository.transition('mixed-terminal', 'asset-1', 'readyToCommit'); repository.transition('mixed-terminal', 'asset-1', 'complete');
    repository.transition('mixed-terminal', 'asset-2', 'rendering'); repository.transition('mixed-terminal', 'asset-2', 'failed', { code: 'FAILED', category: 'transient', message: 'failed', retryable: true, evidencePaths: [] });
    expect(repository.snapshot('mixed-terminal').state).toBe('failed');
    repository.close();
  });

  it('rejects a job whose template qualification lookup is missing', async () => {
    const db = join(await mkdtemp(join(tmpdir(), 'ne-psd-unqualified-')), 'state.sqlite');
    const repository = new JobRepository(db);
    expect(() => repository.createJob(spec('unqualified'), null, rootBinding())).toThrowError(/qualification/i);
    repository.close();
  });

  it('validates job payloads at the repository boundary', async () => {
    const db = join(await mkdtemp(join(tmpdir(), 'ne-psd-runtime-validation-')), 'state.sqlite');
    const repository = new JobRepository(db);
    const value = spec('runtime-invalid');
    repository.recordQualification({ qualificationId: value.profile.qualificationId, profileId: value.profile.profileId, profileSha256: value.profile.profileSha256, evidence: { source: 'test' }, profile: value.profile });
    const malformed = { ...value, maxAttempts: 3, unexpected: true } as unknown;
    expect(() => repository.createJob(malformed, null, rootBinding())).toThrowError(/invalid job specification/i);
    repository.close();
  });

  it('fails closed when persisted job or qualification JSON is tampered', async () => {
    const db = join(await mkdtemp(join(tmpdir(), 'ne-psd-persisted-json-')), 'state.sqlite');
    const repository = new JobRepository(db);
    const value = spec('persisted-json');
    repository.recordQualification({ qualificationId: value.profile.qualificationId, profileId: value.profile.profileId, profileSha256: value.profile.profileSha256, evidence: { source: 'test' }, profile: value.profile });
    repository.createJob(value, null, rootBinding());
    repository.db.prepare('UPDATE jobs SET spec_json=? WHERE job_id=?').run('{bad', value.jobId);
    expect(() => repository.getJobSpec(value.jobId)).toThrowError(/persisted job specification/i);
    repository.db.prepare('UPDATE qualifications SET evidence_json=? WHERE qualification_id=?').run('{bad', value.profile.qualificationId);
    expect(() => repository.getQualification(value.profile.qualificationId)).toThrowError(/persisted qualification/i);
    repository.close();
  });

  it('fails closed for contract-invalid persisted snapshot rows', async () => {
    const db = join(await mkdtemp(join(tmpdir(), 'ne-psd-invalid-snapshot-')), 'state.sqlite');
    const repository = new JobRepository(db);
    const value = spec('invalid-snapshot');
    createQualified(repository, value);
    repository.db.prepare("UPDATE jobs SET state='not-a-state' WHERE job_id=?").run(value.jobId);
    expect(() => repository.snapshot(value.jobId)).toThrowError(/persisted job snapshot/i);
    repository.db.prepare("UPDATE jobs SET state='ready' WHERE job_id=?").run(value.jobId);
    repository.db.prepare("UPDATE assets SET status='not-a-status',attempt=9,error_json=? WHERE job_id=? AND asset_id=?").run(JSON.stringify({ code: 'BAD' }), value.jobId, 'asset-1');
    expect(() => repository.snapshot(value.jobId)).toThrowError(/persisted job snapshot/i);
    repository.close();
  });

  it('fails closed for contract-invalid persisted events', async () => {
    const db = join(await mkdtemp(join(tmpdir(), 'ne-psd-invalid-event-')), 'state.sqlite');
    const repository = new JobRepository(db);
    const value = spec('invalid-event');
    createQualified(repository, value);
    repository.appendEvent(value.jobId, 'snapshot');
    const stored = repository.db.prepare('SELECT sequence,event_json FROM events WHERE job_id=?').get(value.jobId) as { sequence: number; event_json: string };
    const event = JSON.parse(stored.event_json) as Record<string, unknown>;
    event.sequence = stored.sequence + 1;
    (event.snapshot as Record<string, unknown>).jobId = 'foreign-job';
    repository.db.prepare('UPDATE events SET event_json=? WHERE job_id=? AND sequence=?').run(JSON.stringify(event), value.jobId, stored.sequence);
    expect(() => repository.events(value.jobId)).toThrowError(/persisted event/i);
    repository.close();
  });

  it('rejects a tampered profile even when qualification strings match', async () => {
    const db = join(await mkdtemp(join(tmpdir(), 'ne-psd-profile-binding-')), 'state.sqlite');
    const repository = new JobRepository(db);
    const value = spec('tampered-profile');
    value.profile.template.relativePath = 'tampered.psd';
    expect(() => repository.recordQualification({ qualificationId: value.profile.qualificationId, profileId: value.profile.profileId, profileSha256: value.profile.profileSha256, evidence: { source: 'caller' }, profile: value.profile })).toThrowError(/profile digest/i);
    repository.close();
  });

  it('rejects a qualification without persisted sealed profile content', async () => {
    const db = join(await mkdtemp(join(tmpdir(), 'ne-psd-unsealed-qualification-')), 'state.sqlite');
    const repository = new JobRepository(db);
    const value = spec('unsealed-qualification');
    expect(() => repository.recordQualification({ qualificationId: value.profile.qualificationId, profileId: value.profile.profileId, profileSha256: value.profile.profileSha256, evidence: { source: 'caller' } })).toThrowError(/profile digest/i);
    repository.close();
  });

  it('requires the job root binding and derives publication identity from it', async () => {
    const db = join(await mkdtemp(join(tmpdir(), 'ne-psd-root-binding-')), 'state.sqlite');
    const repository = new JobRepository(db);
    const value = spec('root-bound');
    repository.recordQualification({ qualificationId: value.profile.qualificationId, profileId: value.profile.profileId, profileSha256: value.profile.profileSha256, evidence: { source: 'test' }, profile: value.profile });
    expect(() => repository.createJob(value)).toThrowError(/output-root binding/i);
    repository.createJob(value, null, rootBinding());
    repository.transition('root-bound', 'asset-1', 'rendering');
    expect(() => repository.recordPublication({ publicationId: 'traversal', jobId: 'root-bound', assetId: 'asset-1', attempt: 1, transactionKey: 'root-bound:asset-1:1', path: '/tmp/ne-psd-out/../escape' })).toThrow(/output root|binding/i);
    mkdirSync('/tmp/ne-psd-untrusted', { recursive: true });
    try { unlinkSync('/tmp/ne-psd-out/link'); } catch {}
    symlinkSync('/tmp/ne-psd-untrusted', '/tmp/ne-psd-out/link', 'dir');
    expect(() => repository.recordPublication({ publicationId: 'symlink', jobId: 'root-bound', assetId: 'asset-1', attempt: 1, transactionKey: 'root-bound:asset-1:1', path: '/tmp/ne-psd-out/link/file' })).toThrow(/output root|binding/i);
    expect(() => repository.recordPublication({ publicationId: 'wrong-root', jobId: 'root-bound', assetId: 'asset-1', attempt: 1, transactionKey: 'root-bound:asset-1:1', path: '/tmp/untrusted/published' })).toThrow(/output root|binding/i);
    expect(() => repository.recordPublication({ publicationId: 'wrong-key', jobId: 'root-bound', assetId: 'asset-1', attempt: 1, transactionKey: 'caller-key', path: '/tmp/ne-psd-out/published' })).toThrow(/output root|binding|identity/i);
    repository.recordPublication({ publicationId: 'valid-root', jobId: 'root-bound', assetId: 'asset-1', attempt: 1, transactionKey: 'root-bound:asset-1:1', path: '/tmp/ne-psd-out/published' });
    renameSync('/tmp/ne-psd-out', `/tmp/ne-psd-out-replaced-${process.pid}`);
    mkdirSync('/tmp/ne-psd-out', { recursive: true });
    expect(() => repository.recordPublication({ publicationId: 'replaced-root', jobId: 'root-bound', assetId: 'asset-1', attempt: 1, transactionKey: 'root-bound:asset-1:1', path: '/tmp/ne-psd-out/new' })).toThrow(/output root|binding/i);
    repository.close();
  });

  it('fails closed for duplicate, empty, and nonfailed retry selections', async () => {
    const db = join(await mkdtemp(join(tmpdir(), 'ne-psd-retry-selection-')), 'state.sqlite');
    const repository = new JobRepository(db);
    const job = spec('retry-selection');
    job.assets = [job.assets[0]!, { ...job.assets[0]!, assetId: 'asset-2', source: { ...job.assets[0]!.source, relativePath: 'b.png' } }];
    createQualified(repository, job);
    repository.transition('retry-selection', 'asset-1', 'rendering');
    repository.transition('retry-selection', 'asset-1', 'failed', { code: 'FAILED', category: 'transient', message: 'failed', retryable: true, evidencePaths: [] });
    expect(() => repository.retryFailed('retry-selection', ['asset-1', 'asset-1'])).toThrow();
    expect(() => repository.retryFailed('retry-selection', ['asset-2'])).toThrow();
    expect(() => repository.retryFailed('retry-selection', [])).toThrow();
    repository.close();
  });

  it('persists successor linkage and leaves the predecessor unchanged across reopen', async () => {
    const db = join(await mkdtemp(join(tmpdir(), 'ne-psd-retry-reopen-')), 'state.sqlite');
    const repository = new JobRepository(db);
    createQualified(repository, spec('retry-parent'));
    repository.transition('retry-parent', 'asset-1', 'rendering');
    repository.transition('retry-parent', 'asset-1', 'failed', { code: 'FAILED', category: 'transient', message: 'failed', retryable: true, evidencePaths: [] });
    const before = repository.snapshot('retry-parent');
    const successor = repository.retryFailed('retry-parent', ['asset-1']);
    expect(successor.jobId).not.toBe('retry-parent');
    expect(repository.snapshot('retry-parent')).toEqual(before);
    expect(repository.snapshot(successor.jobId).assets[0]).toMatchObject({ assetId: 'asset-1', status: 'queued', attempt: 0 });
    expect(repository.db.prepare('SELECT parent_job_id FROM jobs WHERE job_id=?').get(successor.jobId)).toEqual({ parent_job_id: 'retry-parent' });
    repository.close();

    const reopened = new JobRepository(db);
    expect(reopened.snapshot('retry-parent')).toEqual(before);
    expect(reopened.snapshot(successor.jobId).assets[0]).toMatchObject({ assetId: 'asset-1', status: 'queued', attempt: 0 });
    expect(reopened.db.prepare('SELECT parent_job_id FROM jobs WHERE job_id=?').get(successor.jobId)).toEqual({ parent_job_id: 'retry-parent' });
    reopened.close();
  });

  it('transitions a retried asset by successor job identity', async () => {
    const db = join(await mkdtemp(join(tmpdir(), 'ne-psd-retry-identity-')), 'state.sqlite');
    const repository = new JobRepository(db);
    createQualified(repository, spec('000-parent'));
    repository.transition('000-parent', 'asset-1', 'rendering');
    repository.transition('000-parent', 'asset-1', 'failed', { code: 'FAILED', category: 'transient', message: 'failed', retryable: true, evidencePaths: [] });
    const successor = repository.retryFailed('000-parent', ['asset-1']);
    const predecessorBefore = repository.snapshot('000-parent');
    const predecessorAttemptsBefore = repository.attempts('000-parent', 'asset-1');
    repository.transition(successor.jobId, 'asset-1', 'rendering');
    expect(repository.snapshot(successor.jobId).assets[0]).toMatchObject({ status: 'rendering', attempt: 1 });
    expect(repository.attempts(successor.jobId, 'asset-1')[0]).toMatchObject({ job_id: successor.jobId, transaction_key: `${successor.jobId}:asset-1:1` });
    expect(repository.snapshot('000-parent')).toEqual(predecessorBefore);
    expect(repository.attempts('000-parent', 'asset-1')).toEqual(predecessorAttemptsBefore);
    repository.close();

    const reopened = new JobRepository(db);
    expect(reopened.snapshot('000-parent')).toEqual(predecessorBefore);
    expect(reopened.snapshot(successor.jobId).assets[0]).toMatchObject({ status: 'rendering', attempt: 1 });
    expect(reopened.attempts(successor.jobId, 'asset-1')[0]).toMatchObject({ transaction_key: `${successor.jobId}:asset-1:1` });
    expect(reopened.attempts(successor.jobId, 'asset-1')[0]).not.toMatchObject({ transaction_key: '000-parent:asset-1:1' });
    reopened.close();
  });
});
