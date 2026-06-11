-- Controle de Faturamento (Gestão à Vista do Planejamento). Idempotente.
-- Substitui a planilha "Controle de Pedidos": BASE (controle) + LEGENDA (status)
-- + TB BASE (meta diária). Responsável = usuário da intranet.

-- ===== Status configuráveis (LEGENDA) =====
CREATE TABLE IF NOT EXISTS tab_plan_status (
  id          SERIAL PRIMARY KEY,
  nome        TEXT UNIQUE NOT NULL,
  ordem       INTEGER NOT NULL DEFAULT 100,
  cor         TEXT NOT NULL DEFAULT '#6b7a90',
  e_faturado  BOOLEAN NOT NULL DEFAULT FALSE,   -- status terminal "faturado"
  ativo       BOOLEAN NOT NULL DEFAULT TRUE
);
INSERT INTO tab_plan_status (nome, ordem, cor, e_faturado)
SELECT * FROM (VALUES
  ('AGUARDANDO FATURAMENTO', 10, '#1e5fb5', false),
  ('SEPARAÇÃO',             20, '#6b46c1', false),
  ('FINANCEIRO',            30, '#e07b00', false),
  ('ITENS FALTANTES',       40, '#c0392b', false),
  ('RISCO',                 50, '#e55a1a', false),
  ('TRIANGULAR',            60, '#0e7490', false),
  ('PROBLEMAS',             70, '#8a1f1b', false),
  ('FATURAMENTO PARCIAL',   80, '#f5a500', false),
  ('VERIFICAR',             90, '#6b7a90', false),
  ('PLANEJAMENTO',         100, '#475569', false),
  ('COMERCIAL',            110, '#475569', false),
  ('AGUARDANDO LIBERAÇÃO',  120, '#6b7a90', false),
  ('TOTALMENTE FATURADO',  200, '#1e7d4f', true)
) AS v(nome, ordem, cor, e_faturado)
WHERE NOT EXISTS (SELECT 1 FROM tab_plan_status);

-- ===== Meta mensal (TB BASE) =====
CREATE TABLE IF NOT EXISTS tab_plan_meta (
  mes            TEXT PRIMARY KEY,         -- 'YYYYMM'
  meta_mensal    NUMERIC(14,2) NOT NULL DEFAULT 0,
  dias_uteis     INTEGER NOT NULL DEFAULT 21,
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_por INTEGER
);
INSERT INTO tab_plan_meta (mes, meta_mensal, dias_uteis) VALUES ('202606', 11000000, 21)
ON CONFLICT (mes) DO NOTHING;

-- ===== Controle de pedidos (BASE) =====
CREATE TABLE IF NOT EXISTS tab_plan_controle (
  id                  SERIAL PRIMARY KEY,
  filial              TEXT NOT NULL DEFAULT '01',
  pedido              TEXT NOT NULL,
  responsavel_id      INTEGER,
  responsavel_nome    TEXT,
  status              TEXT,
  tipo_bu             TEXT,
  categoria           TEXT,
  nf                  TEXT,
  obs                 TEXT,
  valor_snapshot      NUMERIC(14,2),
  dt_inicio           DATE NOT NULL DEFAULT CURRENT_DATE,
  ultima_movimentacao TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  faturado_auto       BOOLEAN NOT NULL DEFAULT FALSE,
  criado_em           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  criado_por          INTEGER,
  atualizado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_por      INTEGER,
  UNIQUE (filial, pedido)
);
CREATE INDEX IF NOT EXISTS ix_plan_controle_resp ON tab_plan_controle (responsavel_id);
CREATE INDEX IF NOT EXISTS ix_plan_controle_status ON tab_plan_controle (status);

-- Histórico de movimentações (status/obs)
CREATE TABLE IF NOT EXISTS tab_plan_controle_hist (
  id           SERIAL PRIMARY KEY,
  pedido       TEXT NOT NULL,
  de_status    TEXT,
  para_status  TEXT,
  obs          TEXT,
  usuario_id   INTEGER,
  usuario_nome TEXT,
  criado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_plan_hist_pedido ON tab_plan_controle_hist (pedido, criado_em DESC);

-- ===== Permissão =====
INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo)
SELECT 3003, 'Planejamento - Controle de Faturamento', 'Planejamento'
WHERE NOT EXISTS (SELECT 1 FROM tab_intranet_permissoes WHERE id_permissao = 3003);
