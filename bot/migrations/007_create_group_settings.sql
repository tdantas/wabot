CREATE TABLE IF NOT EXISTS group_settings (
  group_id TEXT PRIMARY KEY,
  listening INTEGER NOT NULL DEFAULT 0,
  troll_mode INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS group_disabled_commands (
  group_id TEXT NOT NULL,
  command TEXT NOT NULL,
  PRIMARY KEY (group_id, command)
) WITHOUT ROWID;
