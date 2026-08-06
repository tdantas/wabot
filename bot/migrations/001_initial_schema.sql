CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Contacts
CREATE TABLE IF NOT EXISTS contacts (
  jid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'person'
);

-- Group settings
CREATE TABLE IF NOT EXISTS group_settings (
  group_id TEXT PRIMARY KEY,
  listening BOOLEAN NOT NULL DEFAULT FALSE,
  troll_mode BOOLEAN NOT NULL DEFAULT FALSE,
  uuid UUID UNIQUE
);

CREATE TABLE IF NOT EXISTS group_disabled_commands (
  group_id TEXT NOT NULL,
  command TEXT NOT NULL,
  PRIMARY KEY (group_id, command)
);

-- Commands registry
CREATE TABLE IF NOT EXISTS commands (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL
);

-- Pending location requests
CREATE TABLE IF NOT EXISTS pending_requests (
  message_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  command TEXT NOT NULL,
  query TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '5 minutes')
);
CREATE INDEX IF NOT EXISTS idx_pending_requests_expires ON pending_requests(expires_at);

-- Bot metrics (key-value store)
CREATE TABLE IF NOT EXISTS bot_metrics (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Live tokens
CREATE TABLE IF NOT EXISTS live_tokens (
  token TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_live_tokens_group ON live_tokens(group_id);

-- Admins
CREATE TABLE IF NOT EXISTS admins (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Events (replaces daily_stats) — individual events for idempotency
CREATE TABLE IF NOT EXISTS events (
  event_id BIGINT GENERATED ALWAYS AS IDENTITY,
  message_id TEXT,
  group_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  activity_type TEXT NOT NULL DEFAULT 'TEXT_MESSAGE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

SELECT create_hypertable('events', 'created_at', chunk_time_interval => INTERVAL '7 days', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_events_group_time ON events (group_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_group_sender_time ON events (group_id, sender, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_message_id ON events (message_id) WHERE message_id IS NOT NULL;
