-- Anotações do time na Análise de Crédito (1 registro por cliente cod+loja,
-- compartilhado). Texto livre exibido abaixo do parecer automático.
CREATE TABLE IF NOT EXISTS tab_credito_anotacao (
  cliente_cod          varchar(10)  NOT NULL,
  cliente_loja         varchar(6)   NOT NULL,
  anotacoes            text         NOT NULL DEFAULT '',
  atualizado_por       integer,
  atualizado_por_nome  varchar(160),
  atualizado_em        timestamptz  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (cliente_cod, cliente_loja)
);
