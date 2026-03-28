-- covering index para as queries de ranking (evita table scan)
DROP INDEX IF EXISTS idx_messages_group_date;
CREATE INDEX idx_messages_group_date_sender ON messages(group_id, date, sender);