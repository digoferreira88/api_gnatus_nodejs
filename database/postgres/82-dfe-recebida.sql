-- SEFAZ DF-e (NFeDistribuicaoDFe) — NF-e recebidas puxadas direto da SEFAZ com o
-- A1 (mTLS), substituindo o token frágil do TOTVS Transmite. Alimenta a Visão 3 do
-- Painel Fiscal (compara recebidas × SF1010.F1_CHVNFE). Idempotente.

CREATE TABLE IF NOT EXISTS tab_dfe_recebida (
  nsu         VARCHAR(15) PRIMARY KEY,          -- NSU do documento na distribuição
  chave       VARCHAR(44),                      -- chNFe (44 díg) quando NF-e
  schema_dfe  VARCHAR(40),                      -- resNFe/procNFe/resEvento/procEventoNFe
  cnpj_emit   VARCHAR(20),
  nome_emit   VARCHAR(200),
  valor       NUMERIC(15,2),
  dh_emi      TIMESTAMPTZ,
  cstat       VARCHAR(5),                        -- situação (cSitNFe) ou cStat do evento
  tp_evento   VARCHAR(10),                       -- se for evento
  xml         TEXT,                              -- XML descompactado (resNFe/procNFe/...)
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_dfe_chave  ON tab_dfe_recebida (chave);
CREATE INDEX IF NOT EXISTS ix_dfe_dhemi  ON tab_dfe_recebida (dh_emi DESC);
CREATE INDEX IF NOT EXISTS ix_dfe_emit   ON tab_dfe_recebida (cnpj_emit);

-- Cursor de NSU por CNPJ (nunca reconsultar do 0 — a SEFAZ pune com cStat 656).
CREATE TABLE IF NOT EXISTS tab_dfe_nsu (
  cnpj          VARCHAR(14) PRIMARY KEY,
  ult_nsu       VARCHAR(15) NOT NULL DEFAULT '000000000000000',
  max_nsu       VARCHAR(15),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON tab_dfe_recebida, tab_dfe_nsu TO intranet;
