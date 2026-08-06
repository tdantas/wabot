-- Mapping from legacy @s.whatsapp.net JIDs to @lid JIDs
CREATE TABLE IF NOT EXISTS jid_map (
  old_jid TEXT PRIMARY KEY,
  lid_jid TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jid_map_lid ON jid_map (lid_jid);
