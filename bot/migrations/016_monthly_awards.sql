-- Prémios mensal (campeão de mensagens do mês) e anual (quem venceu mais
-- meses no ano). Vivem na mesma tabela dos outros, com categorias próprias.
--
-- Um só premiado por grupo em cada apuração, mesmo que o líder mude entre
-- tentativas (restart a meio do dia).
CREATE UNIQUE INDEX IF NOT EXISTS idx_milestone_awards_monthly
  ON milestone_awards (group_id, run_day) WHERE category = 'MONTHLY';

CREATE UNIQUE INDEX IF NOT EXISTS idx_milestone_awards_yearly
  ON milestone_awards (group_id, run_day) WHERE category = 'YEARLY';
