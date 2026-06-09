-- Modulo Analise de Credito 360 (Fase 0 - interno). Idempotente.
-- Tabelas tab_credito_* + seed de pesos/regras + permissoes 11001-11005.

-- ===== Config (key/value editavel: pesos do score, thresholds de classificacao) =====
CREATE TABLE IF NOT EXISTS tab_credito_config (
  chave         TEXT PRIMARY KEY,
  valor         JSONB NOT NULL,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_por INTEGER
);

-- Pesos do score interno (somam 1.0)
INSERT INTO tab_credito_config (chave, valor) VALUES
('pesos', '{
  "pontualidade": 0.28,
  "inadimplencia": 0.20,
  "mediaAtraso": 0.15,
  "piorAtraso": 0.10,
  "tendencia": 0.07,
  "relacionamento": 0.10,
  "utilizacao": 0.10
}'::jsonb)
ON CONFLICT (chave) DO NOTHING;

-- Faixas de classificacao (do escopo). teto = limite superior inclusivo.
INSERT INTO tab_credito_config (chave, valor) VALUES
('classificacao', '[
  {"min": 900, "label": "Excelente",  "cor": "#1a7f3a"},
  {"min": 750, "label": "Baixo risco","cor": "#1e7d4f"},
  {"min": 600, "label": "Médio risco","cor": "#f5a500"},
  {"min": 400, "label": "Alto risco", "cor": "#e55a1a"},
  {"min": 0,   "label": "Crítico",    "cor": "#c9302c"}
]'::jsonb)
ON CONFLICT (chave) DO NOTHING;

-- ===== Motor de regras configuravel =====
CREATE TABLE IF NOT EXISTS tab_credito_regras (
  id         SERIAL PRIMARY KEY,
  nome       TEXT NOT NULL,
  prioridade INTEGER NOT NULL DEFAULT 100,   -- menor = avaliada primeiro; 1a que casa vence
  condicoes  JSONB NOT NULL,                 -- { "all"|"any": [ {campo, op, valor} ] }
  acao       TEXT NOT NULL,                  -- APROVAR | REVISAR | REPROVAR
  mensagem   TEXT,
  ativo      BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Regras default (so insere se a tabela estiver vazia)
INSERT INTO tab_credito_regras (nome, prioridade, condicoes, acao, mensagem)
SELECT * FROM (VALUES
  ('Reprova - risco crítico', 10,
   '{"any":[{"campo":"score_final","op":"lt","valor":500},{"campo":"protesto_ativo","op":"is_true"},{"campo":"media_atraso_dias","op":"gt","valor":30}]}'::jsonb,
   'REPROVAR', 'Score crítico, protesto ativo ou atraso médio elevado.'),
  ('Revisão manual - faixa intermediária', 20,
   '{"all":[{"campo":"score_final","op":"gte","valor":500},{"campo":"score_final","op":"lte","valor":700}]}'::jsonb,
   'REVISAR', 'Score em faixa intermediária — requer análise manual.'),
  ('Aprova - baixo risco', 30,
   '{"all":[{"campo":"score_final","op":"gt","valor":700},{"campo":"protesto_ativo","op":"is_false"}]}'::jsonb,
   'APROVAR', 'Score saudável e sem protesto ativo.')
) AS v(nome, prioridade, condicoes, acao, mensagem)
WHERE NOT EXISTS (SELECT 1 FROM tab_credito_regras);

-- ===== Analise (persistencia de pareceres/decisoes) =====
CREATE TABLE IF NOT EXISTS tab_credito_analise (
  id              SERIAL PRIMARY KEY,
  cliente_cod     TEXT NOT NULL,
  cliente_loja    TEXT NOT NULL,
  cnpj            TEXT,
  contexto        TEXT,                       -- PEDIDO | LIMITE | CADASTRO | RENEGOCIACAO | REATIVACAO
  pedido_ref      TEXT,
  score_interno   NUMERIC(6,1),
  score_externo   NUMERIC(6,1),
  score_final     NUMERIC(6,1),
  classificacao   TEXT,
  status          TEXT,                       -- APROVAR | REVISAR | REPROVAR
  limite_atual    NUMERIC(14,2),
  limite_sugerido NUMERIC(14,2),
  indicadores     JSONB,                      -- snapshot do que o score "viu"
  parecer_ia      TEXT,
  analista_id     INTEGER,
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_credito_analise_cli ON tab_credito_analise (cliente_cod, cliente_loja, criado_em DESC);

-- ===== Score evolutivo / monitoramento =====
CREATE TABLE IF NOT EXISTS tab_credito_score_hist (
  id            SERIAL PRIMARY KEY,
  cliente_cod   TEXT NOT NULL,
  cliente_loja  TEXT NOT NULL,
  score_final   NUMERIC(6,1) NOT NULL,
  classificacao TEXT,
  capturado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_credito_score_hist_cli ON tab_credito_score_hist (cliente_cod, cliente_loja, capturado_em DESC);

-- ===== Permissoes (bloco 15100+, livre — 11001-11004 sao da Controladoria) =====
INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo)
SELECT v.id, v.nome, 'Crédito' FROM (VALUES
  (15100, 'Crédito - Consultar análise (360)'),
  (15101, 'Crédito - Aprovar / Workflow'),
  (15102, 'Crédito - Configurar regras e pesos'),
  (15103, 'Crédito - Gerir limite')
) AS v(id, nome)
WHERE NOT EXISTS (SELECT 1 FROM tab_intranet_permissoes p WHERE p.id_permissao = v.id);
