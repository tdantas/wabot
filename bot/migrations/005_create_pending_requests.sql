CREATE TABLE IF NOT EXISTS pending_requests (
  message_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  command TEXT NOT NULL,
  query TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pending_requests_expires ON pending_requests(expires_at);