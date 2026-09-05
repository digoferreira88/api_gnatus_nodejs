-- CIOSP — módulo de vendas do estande no congresso (Congresso Internacional de
-- Odontologia de São Paulo). Substitui a planilha online + Power BI manual: a
-- pessoa digita a venda na intranet e o dashboard atualiza sozinho.
--
-- Origem: "MATRIZ CIOSP 2026" — 3 abas (EQUIPAMENTOS/DIGITAL/AT), mesmas 19
-- colunas. Aqui viram 1 tabela com a coluna `categoria`. Reutilizável por ano
-- via `edicao` (default 'CIOSP 2026'). Perm 19001 (ver) / 19002 (lançar).

CREATE TABLE IF NOT EXISTS tab_ciosp_venda (
  id             SERIAL PRIMARY KEY,
  edicao         VARCHAR(40)  NOT NULL DEFAULT 'CIOSP 2026',
  categoria      VARCHAR(20)  NOT NULL,          -- EQUIPAMENTOS | DIGITAL | AT
  cliente        VARCHAR(200) NOT NULL,
  cpf_cnpj       VARCHAR(24),
  data_venda     DATE,                            -- "dia do evento"
  vendedor       VARCHAR(120),
  entrega        VARCHAR(40),                     -- Sim/Não/Parcial ou data (livre)
  uf             VARCHAR(4),
  pagto_princ    VARCHAR(60),                     -- Pagamento Principal (cartão/à vista/unicred/...)
  pagto_compl    VARCHAR(60),                     -- Pagamento complementar
  financiadora   VARCHAR(80),
  situacao_fin   VARCHAR(30),                     -- Ok/Pendente
  gerente        VARCHAR(120),                    -- Gerente Responsável
  origem         VARCHAR(20),                     -- Presencial | Online
  equipe         VARCHAR(120),                    -- Equipe / Revenda
  valor          NUMERIC(15,2) NOT NULL DEFAULT 0,
  tabela         VARCHAR(60),
  equipamentos   VARCHAR(300),
  observacao     VARCHAR(300),
  observacao2    VARCHAR(300),
  custo          NUMERIC(15,2),
  criado_por     INTEGER,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_ciosp_ed_cat  ON tab_ciosp_venda (edicao, categoria);
CREATE INDEX IF NOT EXISTS ix_ciosp_ed_data ON tab_ciosp_venda (edicao, data_venda);
CREATE INDEX IF NOT EXISTS ix_ciosp_ed_ger  ON tab_ciosp_venda (edicao, gerente);
CREATE INDEX IF NOT EXISTS ix_ciosp_ed_orig ON tab_ciosp_venda (edicao, origem);

-- Metas por edição (as % dos cartões "Meta Geral" e "Super Meta"). Editável na UI.
CREATE TABLE IF NOT EXISTS tab_ciosp_meta (
  edicao         VARCHAR(40) PRIMARY KEY,
  meta_geral     NUMERIC(15,2) NOT NULL DEFAULT 0,   -- alvo p/ "% Meta Geral"
  super_meta     NUMERIC(15,2) NOT NULL DEFAULT 0,   -- alvo p/ "% Super Meta"
  meta_equip     NUMERIC(15,2) NOT NULL DEFAULT 0,
  meta_digital   NUMERIC(15,2) NOT NULL DEFAULT 0,
  meta_at        NUMERIC(15,2) NOT NULL DEFAULT 0,
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON tab_ciosp_venda, tab_ciosp_meta TO intranet;
GRANT USAGE, SELECT ON SEQUENCE tab_ciosp_venda_id_seq TO intranet;
