-- Subtipo da média: sticker, image, video, audio ou document.
-- O `activity_type` continua MEDIA_MESSAGE para não partir nada que já conte
-- por ele; esta coluna é só detalhe, e fica NULL no histórico anterior.
ALTER TABLE events ADD COLUMN IF NOT EXISTS media_kind TEXT;

CREATE INDEX IF NOT EXISTS idx_events_media_kind
  ON events (group_id, sender, media_kind) WHERE media_kind IS NOT NULL;
