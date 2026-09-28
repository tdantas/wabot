-- Membros omitidos da apresentação: continuam a ser capturados em `events` e
-- `presence`, mas não aparecem em rankings, listas, gráficos, calendário nem
-- nas mensagens do bot. É reversível — basta desligar o toggle e o histórico
-- volta a aparecer inteiro.
CREATE TABLE IF NOT EXISTS omitted_members (
  group_id TEXT NOT NULL,
  sender   TEXT NOT NULL,
  since    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (group_id, sender)
);
