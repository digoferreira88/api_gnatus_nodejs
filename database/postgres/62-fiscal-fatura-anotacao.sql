-- Anotações de trabalho (ação + observação) por pedido na Fila de Faturamento
-- (Painel Fiscal). 1 registro por pedido, compartilhado entre operadores.
-- Espelha tab_lib_financeira_anotacao, mas SEPARADO (contexto fiscal != financeiro).

CREATE TABLE IF NOT EXISTS tab_fiscal_fatura_anotacao (
  filial               varchar(4)   NOT NULL DEFAULT '01',
  pedido               varchar(10)  NOT NULL,
  acoes                text         NOT NULL DEFAULT '',
  observacoes          text         NOT NULL DEFAULT '',
  atualizado_por       integer,
  atualizado_por_nome  varchar(120),
  criado_em            timestamptz  NOT NULL DEFAULT NOW(),
  atualizado_em        timestamptz  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (filial, pedido)
);
