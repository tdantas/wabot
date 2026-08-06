CREATE TABLE IF NOT EXISTS premium_users (
  group_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  PRIMARY KEY (group_id, sender)
);

-- Global premium users (apply to all groups)
CREATE TABLE IF NOT EXISTS global_premium_users (
  sender TEXT PRIMARY KEY
);

-- Seed the bot owner as global premium
INSERT INTO global_premium_users (sender) VALUES ('28935245066426@lid') ON CONFLICT DO NOTHING;
