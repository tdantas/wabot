ALTER TABLE group_metadata ADD COLUMN IF NOT EXISTS transcript_max_seconds INT NOT NULL DEFAULT 30;
