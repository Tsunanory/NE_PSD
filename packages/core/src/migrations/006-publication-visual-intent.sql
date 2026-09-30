CREATE TABLE publication_intents (
  job_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK(attempt IN (1,2)),
  transaction_key TEXT NOT NULL UNIQUE,
  output_root_path TEXT NOT NULL,
  output_root_identity TEXT NOT NULL,
  staging_directory TEXT NOT NULL,
  destination_path TEXT NOT NULL UNIQUE,
  manifest_sha256 TEXT NOT NULL,
  review_id TEXT NOT NULL,
  decision_sha256 TEXT NOT NULL,
  review_policy_sha256 TEXT NOT NULL,
  model_provenance_sha256 TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('prepared','renamed','committed','quarantined')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(job_id,asset_id,attempt),
  FOREIGN KEY(job_id,asset_id,attempt) REFERENCES attempts(job_id,asset_id,attempt) ON DELETE CASCADE
);

CREATE TABLE visual_review_requests (
  request_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK(attempt IN (1,2)),
  request_json TEXT NOT NULL,
  planner_profile_id TEXT NOT NULL,
  reviewer_profile_id TEXT NOT NULL,
  planner_profile_sha256 TEXT NOT NULL,
  reviewer_profile_sha256 TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attestation_json TEXT,
  attestation_relative_path TEXT,
  attestation_sha256 TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(job_id,asset_id,attempt),
  FOREIGN KEY(job_id,asset_id,attempt) REFERENCES attempts(job_id,asset_id,attempt) ON DELETE CASCADE
);

CREATE TABLE pending_reviews (
  job_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK(attempt IN (1,2)),
  staging_directory TEXT NOT NULL,
  output_root_path TEXT NOT NULL,
  output_root_identity TEXT NOT NULL,
  request_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  qa_json TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  profile_sha256 TEXT NOT NULL,
  tool_schema_sha256 TEXT NOT NULL,
  review_policy_sha256 TEXT NOT NULL,
  planner_profile_id TEXT NOT NULL,
  reviewer_profile_id TEXT NOT NULL,
  planner_profile_sha256 TEXT NOT NULL,
  reviewer_profile_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(job_id,asset_id,attempt),
  FOREIGN KEY(job_id,asset_id,attempt) REFERENCES attempts(job_id,asset_id,attempt) ON DELETE CASCADE
);

CREATE UNIQUE INDEX reviews_session_id_unique ON reviews(json_extract(review_json, '$.sessionId'))
  WHERE json_extract(review_json, '$.sessionId') IS NOT NULL;
