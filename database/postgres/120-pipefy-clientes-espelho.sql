-- 120 — Espelho SA1 (Protheus) -> database CLIENTES do Pipefy (22/09/2026)
--
-- Objetivo: manter a tabela (database) "CLIENTES" do Pipefy (id tzFdhr7Y, ~11.745
-- registros) espelhada com o cadastro de clientes do Protheus (SA1010, ~33.189
-- códigos distintos). Cada cliente novo no Protheus vira registro no Pipefy; quando
-- um dado muda (endereço/telefone/e-mail/nome) o registro é atualizado.
--
-- Decisões do usuário (22/09):
--   * Espelho COMPLETO, mas REPRESADO — preenche o gap histórico (~21 mil) com teto
--     diário de chamadas p/ caber na folga do contrato do Pipefy (10.000/mês).
--   * ATUALIZAR mudanças (gated por hash — só chama a API quando o dado muda de fato).
--
-- Como NÃO estoura a cota:
--   - tab_pipefy_clientes_sync guarda o record_id + hash de cada código -> o diff
--     SA1 × Pipefy é feito em Postgres (0 chamadas); só o delta vai pra API.
--   - tab_pipefy_clientes_ctrl conta as GRAVAÇÕES por dia -> teto diário
--     (PIPEFY_CLIENTES_TETO_DIA) trava o backfill.
--   - o SEED (uma vez) pagina a tabela do Pipefy e registra quem já existe lá,
--     evitando recriar duplicado. Códigos no Pipefy que não estão no SA1 = 'orfao'
--     (deixados como estão — o espelho é aditivo, nunca apaga).

-- Estado por código (1 linha por A1_COD; a tabela do Pipefy é chaveada por CÓDIGO)
CREATE TABLE IF NOT EXISTS tab_pipefy_clientes_sync (
  codigo        TEXT PRIMARY KEY,             -- A1_COD (RTRIM)
  record_id     TEXT,                         -- id do registro na table CLIENTES do Pipefy
  hash          TEXT,                         -- hash dos campos espelhados (gate de update); NULL até ter baseline
  status        TEXT NOT NULL DEFAULT 'ok',   -- ok | seed | orfao | erro
  erro          TEXT,
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE tab_pipefy_clientes_sync IS
  'Espelho SA1 -> Pipefy CLIENTES: record_id + hash por código. Diff feito em Postgres p/ economizar API. status orfao = existe no Pipefy e não no SA1 (não mexe).';

-- Contador de gravações (create+update) por dia, p/ o teto diário do backfill.
CREATE TABLE IF NOT EXISTS tab_pipefy_clientes_ctrl (
  dia        DATE PRIMARY KEY,
  gravacoes  INTEGER NOT NULL DEFAULT 0
);

COMMENT ON TABLE tab_pipefy_clientes_ctrl IS
  'Gravações (createTableRecord + update) enviadas ao Pipefy por dia. Teto = PIPEFY_CLIENTES_TETO_DIA (.env).';

-- Log de cada ciclo (auditoria/observabilidade — igual ao tab_op_pipefy_log).
CREATE TABLE IF NOT EXISTS tab_pipefy_clientes_log (
  id             BIGSERIAL PRIMARY KEY,
  origem         TEXT,                         -- CRON | MANUAL | SEED
  sa1            INTEGER NOT NULL DEFAULT 0,
  criados        INTEGER NOT NULL DEFAULT 0,
  atualizados    INTEGER NOT NULL DEFAULT 0,
  erros          INTEGER NOT NULL DEFAULT 0,
  faltando_antes INTEGER NOT NULL DEFAULT 0,
  detalhe        TEXT,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_pipefy_clientes_log_data ON tab_pipefy_clientes_log (criado_em DESC);
