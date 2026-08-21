-- Um marco conquistado não volta a ser dado: a unicidade deixa de incluir o
-- dia e passa a ser por (tipo, grupo, pessoa) para sempre. Quem já levou o de
-- 100 mensagens só recebe algo novo ao alcançar o de 180.

-- limpa eventuais duplicados de dias diferentes, mantendo o primeiro prémio
DELETE FROM milestone_awards a
USING milestone_awards b
WHERE a.award_id > b.award_id
  AND a.type = b.type
  AND a.group_id = b.group_id
  AND a.sender = b.sender;

DROP INDEX IF EXISTS idx_milestone_awards_run;

CREATE UNIQUE INDEX IF NOT EXISTS idx_milestone_awards_once
  ON milestone_awards (type, group_id, sender);
