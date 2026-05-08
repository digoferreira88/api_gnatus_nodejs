-- Financeiro - Envio de Boleto (curadoria de bordero)
-- Onda 1: operador seleciona titulos a expedir pra um banco e cria um "lote".
-- O lote nao gera CNAB — eh uma marcacao de quais titulos foram selecionados,
-- pra rastreio. O operador depois roda ESF050 no Protheus pra produzir o
-- arquivo. Onda 2 (futura): detecta retorno e dispara boleto por email/wpp.

CREATE TABLE IF NOT EXISTS tab_boleto_envio_lote (
    id              SERIAL PRIMARY KEY,
    id_user         int REFERENCES tab_intranet_usr(id) ON DELETE SET NULL,
    usuario_nome    varchar(120),                       -- snapshot
    banco_cod       varchar(10) NOT NULL,
    banco_nome      varchar(120),
    qt_titulos      int NOT NULL,
    valor_total     numeric(14,2) NOT NULL,
    status          varchar(20) NOT NULL DEFAULT 'CRIADO',  -- CRIADO | ENVIADO_PROTHEUS | RETORNADO | DISPARADO | CANCELADO
    observacao      text,
    criado_em       timestamp NOT NULL DEFAULT NOW(),
    atualizado_em   timestamp NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_boleto_lote_user  ON tab_boleto_envio_lote (id_user, criado_em DESC);
CREATE INDEX IF NOT EXISTS ix_boleto_lote_banco ON tab_boleto_envio_lote (banco_cod, criado_em DESC);

CREATE TABLE IF NOT EXISTS tab_boleto_envio_lote_titulo (
    id              SERIAL PRIMARY KEY,
    id_lote         int NOT NULL REFERENCES tab_boleto_envio_lote(id) ON DELETE CASCADE,
    prefixo         varchar(10),
    numero          varchar(20) NOT NULL,
    parcela         varchar(5),
    tipo            varchar(5),
    cliente_cod     varchar(10) NOT NULL,
    cliente_loja    varchar(5)  NOT NULL,
    cliente_nome    varchar(160),
    valor           numeric(14,2),
    saldo           numeric(14,2),
    vencimento      varchar(8),                         -- YYYYMMDD do Protheus
    UNIQUE (id_lote, prefixo, numero, parcela, cliente_cod, cliente_loja)
);
CREATE INDEX IF NOT EXISTS ix_boleto_lt_lote ON tab_boleto_envio_lote_titulo (id_lote);

-- Permissao 8005 — Financeiro - Envio de Boleto (8004 ja eh o Fluxo de Caixa)
INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo) VALUES
  (8005, 'Financeiro - Envio de Boleto', 'Financeiro')
ON CONFLICT (id_permissao) DO UPDATE
   SET nome = EXCLUDED.nome, modulo = EXCLUDED.modulo;
