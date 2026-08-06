-- Group metadata (configurable limits per group)
CREATE TABLE IF NOT EXISTS group_metadata (
  group_id TEXT PRIMARY KEY,
  transcript_daily_limit INT NOT NULL DEFAULT 2
);

-- Track transcript API usage per user per group per day
CREATE TABLE IF NOT EXISTS transcript_usage (
  group_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  used_at DATE NOT NULL DEFAULT CURRENT_DATE,
  count INT NOT NULL DEFAULT 1,
  PRIMARY KEY (group_id, sender, used_at)
);
