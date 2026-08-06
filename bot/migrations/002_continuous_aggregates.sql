-- no-transaction
-- Daily stats continuous aggregate (replaces the old daily_stats table)
-- Aggregates events into daily buckets per group/sender/period

CREATE MATERIALIZED VIEW IF NOT EXISTS daily_stats
WITH (timescaledb.continuous) AS
SELECT
  group_id,
  sender,
  activity_type,
  time_bucket('1 day', created_at) AS bucket,
  EXTRACT(DOW FROM time_bucket('1 day', created_at))::int AS day_of_week,
  CASE
    WHEN EXTRACT(HOUR FROM created_at AT TIME ZONE 'Europe/Lisbon') BETWEEN 6 AND 17
    THEN 'manha' ELSE 'noite'
  END AS period,
  COUNT(*) AS count
FROM events
GROUP BY group_id, sender, activity_type,
         time_bucket('1 day', created_at),
         EXTRACT(DOW FROM time_bucket('1 day', created_at))::int,
         CASE WHEN EXTRACT(HOUR FROM created_at AT TIME ZONE 'Europe/Lisbon') BETWEEN 6 AND 17 THEN 'manha' ELSE 'noite' END;

-- Refresh policy: refresh every 30 minutes, looking back 3 days
SELECT add_continuous_aggregate_policy('daily_stats',
  start_offset => INTERVAL '90 days',
  end_offset => INTERVAL '30 minutes',
  schedule_interval => INTERVAL '30 minutes',
  if_not_exists => TRUE);
