ALTER TABLE attempts ADD COLUMN v2_installation_id TEXT;
ALTER TABLE attempts ADD COLUMN v2_operation_id TEXT;
ALTER TABLE attempts ADD COLUMN v2_staging_directory TEXT;
ALTER TABLE attempts ADD COLUMN v2_source_root_identity TEXT;
ALTER TABLE attempts ADD COLUMN v2_state TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS attempts_v2_operation_id_unique ON attempts(v2_operation_id) WHERE v2_operation_id IS NOT NULL;
