ALTER TABLE group_settings ADD COLUMN uuid TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_group_settings_uuid ON group_settings (uuid);
