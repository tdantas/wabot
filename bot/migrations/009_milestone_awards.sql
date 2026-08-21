-- Prémios de milestone já entregues. Guarda o período avaliado para permitir
-- recalcular o resultado no futuro.
--   category DAILY  → DAILY_100, DAILY_180  (contagem de mensagens do dia)
--   category WEEKLY → POKER, HAT_TRICK, BISOU (liderança de várias janelas)
CREATE TABLE IF NOT EXISTS milestone_awards (
  award_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type TEXT NOT NULL,
  category TEXT NOT NULL,
  group_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  run_day DATE NOT NULL,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  -- parâmetros do cálculo: {100} ou {180} nos diários, as janelas nos semanais
  params INT[] NOT NULL DEFAULT '{}',
  awarded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- um prémio de cada tipo por pessoa, por grupo, por dia: é isto que impede o
-- bot de repetir o parabéns depois de um restart ou com duas instâncias no ar
CREATE UNIQUE INDEX IF NOT EXISTS idx_milestone_awards_run
  ON milestone_awards (type, group_id, sender, run_day);

-- os semanais são mais restritos: um único premiado por grupo em cada
-- execução, mesmo que o líder ou o marco mudem entre uma tentativa e outra
CREATE UNIQUE INDEX IF NOT EXISTS idx_milestone_awards_weekly
  ON milestone_awards (group_id, run_day) WHERE category = 'WEEKLY';

CREATE INDEX IF NOT EXISTS idx_milestone_awards_sender
  ON milestone_awards (group_id, sender, awarded_at DESC);
