-- 128 — CIOSP: orçamento e pedido digitais (substitui os dois talões de papel) — 09/10/2026
--
-- O vendedor do estande preenche hoje dois talões: um de orçamento (proposta solta)
-- e um de pedido (que é um CONTRATO de compra e venda com reserva de domínio). Este
-- módulo digitaliza os dois, com item de verdade — hoje o equipamento é texto livre
-- em tab_ciosp_venda ("G1 SF + Kit BV"), o que impede qualquer análise por produto.
--
-- Decisões que estão embutidas no desenho (ver doc "CIOSP — Orçamentos e Pedidos"):
--   - uuid gerado no DISPOSITIVO é a chave: dois tablets offline não podem colidir.
--     O número bonito (000123) é do servidor, atribuído por edição.
--   - preco_tabela e preco são colunas separadas: é a única forma de medir desconto.
--   - a conversão COPIA os itens; o orçamento continua existindo como foi aprovado.
--   - o cliente mora no documento, com o código do ERP quando resolvido — 11% dos
--     atendimentos do CIOSP 2026 eram cliente que ainda não existia na SA1.
--
-- A integração com o Protheus NÃO entra aqui: os pedidos do evento usam TES que a
-- rotina da staging não demonstrou saber (574/575/554/624/625/598/593). Na fase 1 o
-- admin abre o pedido e imprime o contrato.

-- ---------------------------------------------------------------- orçamento
CREATE TABLE IF NOT EXISTS tab_ciosp_orcamento (
  id               SERIAL PRIMARY KEY,
  uuid             UUID NOT NULL UNIQUE,              -- gerado no dispositivo
  edicao           VARCHAR(40) NOT NULL DEFAULT 'CIOSP 2026',
  numero           INTEGER,                            -- sequencial por edição (servidor)

  -- cliente: o que o talão pede, mais o vínculo com o ERP quando existe
  cliente_doc      VARCHAR(14),                        -- só dígitos
  cliente_nome     VARCHAR(200),
  cliente_cod      VARCHAR(10),                        -- A1_COD quando resolvido
  cliente_loja     VARCHAR(4),
  cliente_tipo     VARCHAR(20),                        -- academica | clinica | profissional | outros
  cliente_cro      VARCHAR(20),
  cliente_email    VARCHAR(120),
  cliente_email2   VARCHAR(120),
  cliente_fone     VARCHAR(40),
  cliente_celular  VARCHAR(40),
  cliente_cep      VARCHAR(9),
  cliente_endereco VARCHAR(200),
  cliente_bairro   VARCHAR(80),
  cliente_cidade   VARCHAR(80),
  cliente_uf       CHAR(2),

  vendedor_id      INTEGER,                            -- usuário da intranet
  vendedor_nome    VARCHAR(120),
  tabela_preco     VARCHAR(10),                        -- DA0 usada (hoje ninguém registra)
  validade         DATE,
  situacao         VARCHAR(16) NOT NULL DEFAULT 'rascunho',
                   -- rascunho | enviado | negociando | aprovado | convertido | perdido | expirado
  motivo_perda     VARCHAR(200),
  observacao       TEXT,

  total_bruto      NUMERIC(15,2) NOT NULL DEFAULT 0,   -- soma a preço de tabela
  total_desconto   NUMERIC(15,2) NOT NULL DEFAULT 0,
  total            NUMERIC(15,2) NOT NULL DEFAULT 0,

  dispositivo      VARCHAR(60),                        -- de onde veio (offline, fase 3)
  criado_em        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  criado_por       INTEGER,
  atualizado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_por   INTEGER
);

CREATE INDEX IF NOT EXISTS ix_ciosp_orc_edicao   ON tab_ciosp_orcamento (edicao, situacao);
CREATE INDEX IF NOT EXISTS ix_ciosp_orc_vendedor ON tab_ciosp_orcamento (edicao, vendedor_id);
CREATE INDEX IF NOT EXISTS ix_ciosp_orc_doc      ON tab_ciosp_orcamento (cliente_doc);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ciosp_orc_numero ON tab_ciosp_orcamento (edicao, numero) WHERE numero IS NOT NULL;

COMMENT ON COLUMN tab_ciosp_orcamento.uuid IS
  'Chave de verdade: nasce no dispositivo. Reenviar o mesmo uuid atualiza, nunca duplica.';

CREATE TABLE IF NOT EXISTS tab_ciosp_orcamento_item (
  id               SERIAL PRIMARY KEY,
  orcamento_id     INTEGER NOT NULL REFERENCES tab_ciosp_orcamento(id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL DEFAULT 1,
  produto          VARCHAR(15),                        -- B1_COD; vazio = item livre
  descricao        VARCHAR(200) NOT NULL,
  modelo           VARCHAR(80),
  quantidade       NUMERIC(12,3) NOT NULL DEFAULT 1,
  preco_tabela     NUMERIC(15,2) NOT NULL DEFAULT 0,
  preco            NUMERIC(15,2) NOT NULL DEFAULT 0,   -- praticado
  desconto_pct     NUMERIC(6,2)  NOT NULL DEFAULT 0,
  total            NUMERIC(15,2) NOT NULL DEFAULT 0,
  cor_estofamento  VARCHAR(40),
  voltagem         VARCHAR(20),
  prazo_fabric     INTEGER,                            -- dias, do talão de pedido
  familia          VARCHAR(40)                         -- bloco do talão (Imagem, Biossegurança…)
);

CREATE INDEX IF NOT EXISTS ix_ciosp_orc_item ON tab_ciosp_orcamento_item (orcamento_id, seq);

-- ---------------------------------------------------------------- pedido
CREATE TABLE IF NOT EXISTS tab_ciosp_pedido (
  id               SERIAL PRIMARY KEY,
  uuid             UUID NOT NULL UNIQUE,
  edicao           VARCHAR(40) NOT NULL DEFAULT 'CIOSP 2026',
  numero           INTEGER,
  orcamento_id     INTEGER REFERENCES tab_ciosp_orcamento(id),  -- NULL = pedido direto

  cliente_doc      VARCHAR(14),
  cliente_nome     VARCHAR(200),
  cliente_cod      VARCHAR(10),
  cliente_loja     VARCHAR(4),
  cliente_rg_ie    VARCHAR(30),
  cliente_resp     VARCHAR(120),                       -- profissional responsável
  cliente_cro      VARCHAR(20),
  cliente_email    VARCHAR(120),
  cliente_email2   VARCHAR(120),
  cliente_fone     VARCHAR(40),
  cliente_celular  VARCHAR(40),
  cliente_cep      VARCHAR(9),
  cliente_endereco VARCHAR(200),
  cliente_bairro   VARCHAR(80),
  cliente_cidade   VARCHAR(80),
  cliente_uf       CHAR(2),

  vendedor_id      INTEGER,
  vendedor_nome    VARCHAR(120),
  revenda          VARCHAR(120),
  tabela_preco     VARCHAR(10),

  cond_pagto       VARCHAR(60),                        -- à vista | cartão crédito | débito | parcelamento direto
  parcelas         INTEGER,
  valor_parcela    NUMERIC(15,2),
  frete_tipo       VARCHAR(10) NOT NULL DEFAULT 'gratis',   -- gratis | comprador
  frete_valor      NUMERIC(15,2) NOT NULL DEFAULT 0,
  acrescimo_norte  NUMERIC(15,2) NOT NULL DEFAULT 0,   -- 3% da cláusula 5 (AC/AM/RO/RR/PA/AP)

  entrega_parcial  BOOLEAN NOT NULL DEFAULT FALSE,
  entrega_cep      VARCHAR(9),
  entrega_endereco VARCHAR(200),
  entrega_bairro   VARCHAR(80),
  entrega_cidade   VARCHAR(80),
  entrega_uf       CHAR(2),
  entrega_celular  VARCHAR(40),
  prazo_entrega    INTEGER,                            -- dias; em branco no contrato = 30

  situacao         VARCHAR(16) NOT NULL DEFAULT 'rascunho',
                   -- rascunho | conferido | impresso | cancelado | integrado
  motivo_cancel    VARCHAR(200),
  observacao       TEXT,

  total_bruto      NUMERIC(15,2) NOT NULL DEFAULT 0,
  total_desconto   NUMERIC(15,2) NOT NULL DEFAULT 0,
  total            NUMERIC(15,2) NOT NULL DEFAULT 0,   -- à vista
  total_prazo      NUMERIC(15,2) NOT NULL DEFAULT 0,

  protheus_pedido  VARCHAR(6),                         -- preenchido na fase de integração
  dispositivo      VARCHAR(60),
  criado_em        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  criado_por       INTEGER,
  atualizado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_por   INTEGER
);

CREATE INDEX IF NOT EXISTS ix_ciosp_ped_edicao   ON tab_ciosp_pedido (edicao, situacao);
CREATE INDEX IF NOT EXISTS ix_ciosp_ped_vendedor ON tab_ciosp_pedido (edicao, vendedor_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ciosp_ped_numero ON tab_ciosp_pedido (edicao, numero) WHERE numero IS NOT NULL;

CREATE TABLE IF NOT EXISTS tab_ciosp_pedido_item (
  id               SERIAL PRIMARY KEY,
  pedido_id        INTEGER NOT NULL REFERENCES tab_ciosp_pedido(id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL DEFAULT 1,
  produto          VARCHAR(15),
  descricao        VARCHAR(200) NOT NULL,
  modelo           VARCHAR(80),
  quantidade       NUMERIC(12,3) NOT NULL DEFAULT 1,
  preco_tabela     NUMERIC(15,2) NOT NULL DEFAULT 0,
  preco            NUMERIC(15,2) NOT NULL DEFAULT 0,
  desconto_pct     NUMERIC(6,2)  NOT NULL DEFAULT 0,
  total            NUMERIC(15,2) NOT NULL DEFAULT 0,
  cor_estofamento  VARCHAR(40),
  voltagem         VARCHAR(20),
  prazo_fabric     INTEGER,
  familia          VARCHAR(40)
);

CREATE INDEX IF NOT EXISTS ix_ciosp_ped_item ON tab_ciosp_pedido_item (pedido_id, seq);

-- ---------------------------------------------------------------- trilha
CREATE TABLE IF NOT EXISTS tab_ciosp_doc_log (
  id          SERIAL PRIMARY KEY,
  documento   VARCHAR(10) NOT NULL,        -- orcamento | pedido
  documento_id INTEGER NOT NULL,
  acao        VARCHAR(24) NOT NULL,        -- criou | alterou | enviou | converteu | imprimiu | cancelou
  de          TEXT,
  para        TEXT,
  usuario_id  INTEGER,
  em          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_ciosp_doc_log ON tab_ciosp_doc_log (documento, documento_id, em DESC);

-- ---------------------------------------------------------------- permissões
-- 19001 (ver) e 19002 (lançar) já existem para o módulo de vendas do CIOSP e
-- continuam valendo. As duas novas são os níveis que o módulo de orçamento pede.
INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo) VALUES
  (19001, 'CIOSP - Ver painel e lançamentos',              'CIOSP'),
  (19002, 'CIOSP - Lançar vendas, orçamentos e pedidos',    'CIOSP'),
  (19003, 'CIOSP - Supervisão (ver a equipe, aprovar desconto)', 'CIOSP'),
  (19004, 'CIOSP - Administração (eventos, de-para, impressão do contrato)', 'CIOSP')
ON CONFLICT (id_permissao) DO NOTHING;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  tab_ciosp_orcamento, tab_ciosp_orcamento_item,
  tab_ciosp_pedido, tab_ciosp_pedido_item, tab_ciosp_doc_log TO intranet;
GRANT USAGE, SELECT ON SEQUENCE
  tab_ciosp_orcamento_id_seq, tab_ciosp_orcamento_item_id_seq,
  tab_ciosp_pedido_id_seq, tab_ciosp_pedido_item_id_seq, tab_ciosp_doc_log_id_seq TO intranet;
