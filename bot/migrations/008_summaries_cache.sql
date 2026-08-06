CREATE TABLE IF NOT EXISTS summaries (
  url_hash TEXT PRIMARY KEY,
  canonical_url TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
