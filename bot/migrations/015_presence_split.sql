-- Separa participação de presença passiva no mesmo balde:
--   actions → escrever, reagir, editar, apagar
--   passive → ler, estar online / a escrever
-- `events` continua a ser o total (actions + passive) e é o que dá a cor.
ALTER TABLE presence
  ADD COLUMN IF NOT EXISTS actions INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS passive INT NOT NULL DEFAULT 0;

-- Linhas já existentes: o backfill do histórico é todo participação, e a
-- captura ao vivo até aqui foi maioritariamente escrita. Atribuir tudo a
-- `actions` é a aproximação honesta — o que veio de leitura nesse período
-- não é recuperável.
UPDATE presence SET actions = events WHERE actions = 0 AND passive = 0;
