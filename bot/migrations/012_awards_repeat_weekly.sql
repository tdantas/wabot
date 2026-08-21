-- Separa os dois conceitos:
--   MILESTONE (category DAILY)  → 100/150/180 mensagens no dia, uma vez na vida
--   PRÉMIO    (category WEEKLY) → BISOU/HAT TRICK/POKER, repetível a cada domingo
-- A unicidade vitalícia passa a valer só para os milestones diários; o prémio
-- semanal continua limitado a um por grupo por domingo (índice da 009).
DROP INDEX IF EXISTS idx_milestone_awards_once;

CREATE UNIQUE INDEX IF NOT EXISTS idx_milestone_awards_daily_once
  ON milestone_awards (type, group_id, sender) WHERE category = 'DAILY';
