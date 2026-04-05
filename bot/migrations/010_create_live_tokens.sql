CREATE TABLE IF NOT EXISTS live_tokens (
  token TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_live_tokens_group ON live_tokens (group_id);
