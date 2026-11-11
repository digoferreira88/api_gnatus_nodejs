-- 149 — CIOSP: gestão da edição (tabela de preços por linha, formas de pagamento,
-- equipe do evento, fotos e catálogos) — 11/11/2026
--
-- Spec: docs/superpowers/specs/2026-11-11-ciosp-estande-design.md (seção 4).
--
-- A tabela de preços do evento passa a ser POR LINHA da Tabela Comercial, não por
-- código de produto: o mesmo código tem preços diferentes conforme a seção (refletor
-- 9442 = R$ 1.410,14 avulso, R$ 1.269,13 opcional da HOF, R$ 424,66 upgrade do G1 Fit)
-- e há códigos compostos ("5472 + 1134"), "CONF COR" e consultórios sem código.
-- Cada linha traz os 4 preços impressos: tabela 13% / 11% (comissão do vendedor) ×
-- "10x no cartão ou 10% no Pix" / "6x no cartão ou 6% no Pix".
--
-- Idempotente. Produção: sudo cat ... | sudo -u postgres psql -d intranet -v ON_ERROR_STOP=1

-- ---------------------------------------------------------------- tabela antiga (129)
-- Só tinha dados de teste, mas não se apaga nada: se a tabela ainda tem o formato da
-- 129 (coluna `preco`), ela é renomeada e fica de arquivo.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'tab_ciosp_preco' AND column_name = 'preco') THEN
    ALTER TABLE tab_ciosp_preco RENAME TO tab_ciosp_preco_v129;
    ALTER INDEX IF EXISTS ix_ciosp_preco_edicao RENAME TO ix_ciosp_preco_v129_edicao;
    ALTER INDEX IF EXISTS ux_ciosp_preco_item   RENAME TO ux_ciosp_preco_v129_item;
    ALTER SEQUENCE IF EXISTS tab_ciosp_preco_id_seq RENAME TO tab_ciosp_preco_v129_id_seq;
    ALTER INDEX IF EXISTS tab_ciosp_preco_pkey RENAME TO tab_ciosp_preco_v129_pkey;
  END IF;
END $$;

-- ---------------------------------------------------------------- importações
CREATE TABLE IF NOT EXISTS tab_ciosp_preco_importacao (
  id          SERIAL PRIMARY KEY,
  edicao      VARCHAR(40)  NOT NULL,
  arquivo     VARCHAR(200),
  linhas      INTEGER      NOT NULL DEFAULT 0,
  com_produto INTEGER      NOT NULL DEFAULT 0,
  criado_por  INTEGER,
  criado_em   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_ciosp_preco_imp_edicao ON tab_ciosp_preco_importacao (edicao, criado_em DESC);

-- ---------------------------------------------------------------- tabela de preços
CREATE TABLE IF NOT EXISTS tab_ciosp_preco (
  id                   SERIAL PRIMARY KEY,
  edicao               VARCHAR(40)   NOT NULL,
  ordem                INTEGER       NOT NULL,             -- posição na planilha
  secao                VARCHAR(60),                        -- "PEÇAS DE MÃO", "CONSULTÓRIOS GNATUS G2"…
  grupo                VARCHAR(120),                       -- subtítulo dentro da seção
  tes                  VARCHAR(20),                        -- como impresso ("530", "531 + 530")
  codigo               VARCHAR(60),                        -- como impresso ("1116", "5472 + 1134", "CONF COR")
  produto              VARCHAR(15),                        -- B1_COD quando o código é único e existe no SB1
  descricao            TEXT          NOT NULL,
  preco_13_10x         NUMERIC(15,2) NOT NULL,
  preco_13_6x          NUMERIC(15,2) NOT NULL,
  preco_11_10x         NUMERIC(15,2) NOT NULL,
  preco_11_6x          NUMERIC(15,2) NOT NULL,
  promocao_texto       VARCHAR(300),
  promocao_pct         NUMERIC(6,2),
  promocao_condicional BOOLEAN       NOT NULL DEFAULT FALSE,
  prazo_fabric         INTEGER,                            -- dias
  foto_id              INTEGER,                            -- foto específica da linha
  ativo                BOOLEAN       NOT NULL DEFAULT TRUE,
  importacao_id        INTEGER REFERENCES tab_ciosp_preco_importacao(id),
  criado_em            TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_ciosp_preco_ed_ativo ON tab_ciosp_preco (edicao, ativo, ordem);
-- Duas linhas iguais em seções diferentes são legítimas; o que não pode é duas linhas
-- ativas na mesma posição da tabela.
CREATE UNIQUE INDEX IF NOT EXISTS ux_ciosp_preco_ordem ON tab_ciosp_preco (edicao, ordem) WHERE ativo;

COMMENT ON TABLE tab_ciosp_preco IS
  'Tabela Comercial do evento, uma linha por linha impressa. Reimportar desativa a anterior. Fonte do catálogo do vendedor.';

-- ---------------------------------------------------------------- formas de pagamento
CREATE TABLE IF NOT EXISTS tab_ciosp_forma_pagto (
  id            SERIAL PRIMARY KEY,
  edicao        VARCHAR(40)  NOT NULL,
  ordem         INTEGER      NOT NULL DEFAULT 0,
  nome          VARCHAR(60)  NOT NULL,
  coluna_base   VARCHAR(3)   NOT NULL CHECK (coluna_base IN ('10x', '6x')),
  desconto_pct  NUMERIC(6,2) NOT NULL DEFAULT 0 CHECK (desconto_pct >= 0 AND desconto_pct < 100),
  parcelas_max  INTEGER      NOT NULL DEFAULT 1 CHECK (parcelas_max BETWEEN 1 AND 24),
  exige_credito BOOLEAN      NOT NULL DEFAULT FALSE,
  financeira    BOOLEAN      NOT NULL DEFAULT FALSE,
  ativo         BOOLEAN      NOT NULL DEFAULT TRUE,
  atualizado_em TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (edicao, nome)
);

-- ---------------------------------------------------------------- equipe do evento
CREATE TABLE IF NOT EXISTS tab_ciosp_equipe (
  id            SERIAL PRIMARY KEY,
  edicao        VARCHAR(40)  NOT NULL,
  usuario_id    INTEGER      NOT NULL,
  nome_exibicao VARCHAR(120) NOT NULL,
  papel         VARCHAR(10)  NOT NULL CHECK (papel IN ('vendedor', 'gerente')),
  gerente_id    INTEGER,                                  -- usuario_id do gerente
  categoria     VARCHAR(20)  CHECK (categoria IN ('EQUIPAMENTOS', 'DIGITAL', 'AT')),
  equipe        VARCHAR(120),                             -- equipe ou revenda
  ativo         BOOLEAN      NOT NULL DEFAULT TRUE,
  atualizado_em TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (edicao, usuario_id)
);

-- ---------------------------------------------------------------- fotos e catálogos
CREATE TABLE IF NOT EXISTS tab_ciosp_midia (
  id          SERIAL PRIMARY KEY,
  edicao      VARCHAR(40)  NOT NULL,
  tipo        VARCHAR(10)  NOT NULL CHECK (tipo IN ('foto', 'catalogo')),
  titulo      VARCHAR(200),
  arquivo     VARCHAR(80)  NOT NULL,                      -- <sha256>.<ext>
  mime        VARCHAR(60)  NOT NULL,
  bytes       INTEGER      NOT NULL,
  codigo      VARCHAR(60),                                -- foto: código impresso
  secao       VARCHAR(60),                                -- catálogo: seção
  ativo       BOOLEAN      NOT NULL DEFAULT TRUE,
  enviado_por INTEGER,
  enviado_em  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_ciosp_midia_ed ON tab_ciosp_midia (edicao, ativo, tipo);

-- ---------------------------------------------------------------- configuração da edição
ALTER TABLE tab_ciosp_meta ADD COLUMN IF NOT EXISTS ativa                   BOOLEAN      NOT NULL DEFAULT FALSE;
ALTER TABLE tab_ciosp_meta ADD COLUMN IF NOT EXISTS desconto_livre_pct      NUMERIC(6,2) NOT NULL DEFAULT 0;
ALTER TABLE tab_ciosp_meta ADD COLUMN IF NOT EXISTS validade_orcamento_dias INTEGER      NOT NULL DEFAULT 7;
ALTER TABLE tab_ciosp_meta ADD COLUMN IF NOT EXISTS versao_pacote           VARCHAR(40);

COMMENT ON COLUMN tab_ciosp_meta.ativa IS 'Edição usada pelo app do estande e pelo catálogo. Uma por vez.';
COMMENT ON COLUMN tab_ciosp_meta.desconto_livre_pct IS
  'Desconto que o vendedor dá sem o gerente, somado ao % da promoção da linha. 0 = só a promoção.';
COMMENT ON COLUMN tab_ciosp_meta.versao_pacote IS
  'Muda a cada alteração de preço, forma, equipe ou mídia: é como o app sabe que precisa baixar de novo.';

-- ---------------------------------------------------------------- permissão
INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo) VALUES
  (19005, 'CIOSP - App do estande (vendedor e gerente)', 'CIOSP')
ON CONFLICT (id_permissao) DO NOTHING;

-- ---------------------------------------------------------------- grants
GRANT SELECT, INSERT, UPDATE, DELETE ON
  tab_ciosp_preco, tab_ciosp_preco_importacao, tab_ciosp_forma_pagto, tab_ciosp_equipe, tab_ciosp_midia
  TO intranet;
GRANT USAGE, SELECT ON SEQUENCE
  tab_ciosp_preco_id_seq, tab_ciosp_preco_importacao_id_seq, tab_ciosp_forma_pagto_id_seq,
  tab_ciosp_equipe_id_seq, tab_ciosp_midia_id_seq
  TO intranet;
