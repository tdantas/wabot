-- Pedidos de melhoria feitos com !request. O texto é truncado a 2000
-- caracteres pelo bot antes de gravar; o VARCHAR é a rede de segurança.
-- O estado e as datas são geridos na UI de admin.
CREATE TABLE IF NOT EXISTS requests (
  request_id           SERIAL PRIMARY KEY,
  group_id             TEXT NOT NULL,
  sender               TEXT NOT NULL,
  texto                VARCHAR(2000) NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pendente'
                         CHECK (status IN ('pendente', 'aprovado', 'recusado')),
  inicio_implementacao DATE,
  deploy_estimado      DATE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_requests_group ON requests (group_id, created_at DESC);
