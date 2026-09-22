PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY,
  spec_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'ready',
  schema_version INTEGER NOT NULL,
  contract_version INTEGER NOT NULL,
  parent_job_id TEXT REFERENCES jobs(job_id),
  requested_control TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assets (
  asset_id TEXT NOT NULL,
  job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
  source_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempt INTEGER NOT NULL DEFAULT 0,
  error_json TEXT,
  PRIMARY KEY(job_id, asset_id)
);

CREATE TABLE IF NOT EXISTS attempts (
  job_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  transaction_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,
  evidence_json TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(job_id, asset_id, attempt),
  FOREIGN KEY(job_id, asset_id) REFERENCES assets(job_id, asset_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS events (
  job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL,
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(job_id, sequence)
);

CREATE TABLE IF NOT EXISTS reviews (
  review_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  review_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(job_id, asset_id, attempt),
  FOREIGN KEY(job_id, asset_id) REFERENCES assets(job_id, asset_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS publications (
  publication_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  transaction_key TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL,
  manifest_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(job_id, asset_id) REFERENCES assets(job_id, asset_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS qualifications (
  qualification_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  profile_sha256 TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(profile_id, profile_sha256)
);
