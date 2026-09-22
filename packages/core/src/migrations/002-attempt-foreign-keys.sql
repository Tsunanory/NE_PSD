ALTER TABLE reviews RENAME TO reviews_legacy;
CREATE TABLE reviews (
  review_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  review_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(job_id, asset_id, attempt),
  FOREIGN KEY(job_id, asset_id, attempt) REFERENCES attempts(job_id, asset_id, attempt) ON DELETE CASCADE
);
INSERT INTO reviews(review_id,job_id,asset_id,attempt,review_json,created_at)
SELECT review_id,job_id,asset_id,attempt,review_json,created_at FROM reviews_legacy;
DROP TABLE reviews_legacy;

ALTER TABLE publications RENAME TO publications_legacy;
CREATE TABLE publications (
  publication_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  transaction_key TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL,
  manifest_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(job_id, asset_id, attempt) REFERENCES attempts(job_id, asset_id, attempt) ON DELETE CASCADE
);
INSERT INTO publications(publication_id,job_id,asset_id,attempt,transaction_key,path,manifest_json,created_at)
SELECT publication_id,job_id,asset_id,attempt,transaction_key,path,manifest_json,created_at FROM publications_legacy;
DROP TABLE publications_legacy;
