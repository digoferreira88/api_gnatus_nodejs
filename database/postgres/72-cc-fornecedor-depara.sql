-- De-para FORNECEDOR -> CENTRO DE CUSTO para títulos lançados direto no
-- financeiro (FINA050 — fatura de cartão: MONDAY, ADOBE, PIPEFY...), que não
-- têm pedido de compra e quase nunca têm CC no Protheus (E2_CCD vazio, sem
-- rateio SEZ). O DRE por Centro de Custo usa este de-para como 3º nível de
-- atribuição: E2_CCD > rateio SEZ010 > de-para > "(sem CC)". Idempotente.
-- Gestão na própria aba CC do DRE (perm 10001, sem perm nova).

CREATE TABLE IF NOT EXISTS tab_cc_fornecedor_depara (
  id             SERIAL PRIMARY KEY,
  fornece        VARCHAR(20) NOT NULL,
  loja           VARCHAR(10) NOT NULL DEFAULT '',   -- '' = todas as lojas do fornecedor
  cc             VARCHAR(20) NOT NULL,
  observacao     TEXT,
  atualizado_por INTEGER REFERENCES tab_intranet_usr(id),
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (fornece, loja)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON tab_cc_fornecedor_depara TO intranet;
GRANT USAGE, SELECT ON SEQUENCE tab_cc_fornecedor_depara_id_seq TO intranet;
