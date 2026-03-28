DROP INDEX IF EXISTS idx_messages_group_date_sender;
DROP TABLE IF EXISTS messages;

CREATE TABLE daily_stats (
  group_id    TEXT NOT NULL,
  sender      TEXT NOT NULL,
  date        TEXT NOT NULL,
  day_of_week INTEGER NOT NULL,
  period      TEXT NOT NULL,
  count       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, sender, date, period)
) WITHOUT ROWID;

CREATE INDEX idx_daily_stats_group_date ON daily_stats(group_id, date);
