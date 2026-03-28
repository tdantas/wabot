CREATE TABLE IF NOT EXISTS bot_metrics (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
) WITHOUT ROWID;
