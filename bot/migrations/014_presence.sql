-- Presença por leitura: quem estava a acompanhar o grupo, e quando.
--
-- Deliberadamente fora da tabela `events`: as queries de ranking contam
-- COUNT(*) sem filtrar activity_type, por isso guardar leituras lá dentro
-- inflacionaria rankings, marcos e calendário.
--
-- Uma linha por pessoa, por grupo, por balde de tempo — as 200 leituras de
-- quem volta ao grupo depois de um dia fora colapsam num único registo.
CREATE TABLE IF NOT EXISTS presence (
  group_id TEXT NOT NULL,
  sender   TEXT NOT NULL,
  bucket   TIMESTAMPTZ NOT NULL,
  events   INT NOT NULL DEFAULT 1,
  PRIMARY KEY (group_id, sender, bucket)
);

CREATE INDEX IF NOT EXISTS idx_presence_group_bucket ON presence (group_id, bucket DESC);
