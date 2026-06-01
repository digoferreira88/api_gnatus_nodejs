-- 53-natureza-classificacao.sql
-- Classificacao gerencial das naturezas financeiras do Protheus (SE2.E2_NATUREZ).
--
-- Por que existe: o dashboard de Receita (e o DRE Gerencial) precisam saber,
-- para cada natureza:
--   tipo          CUSTO  / DESPESA  / RECEITA
--   classificacao VARIAVEL / FIXO   (so faz sentido pra custo/despesa)
--   operacional   true (regra do negocio) / false (financeiro, ganhos
--                                                  nao recorrentes, etc)
--
-- Hoje essas regras viviam HARDCODED em resources/gerencia/gerencia.dre.js
-- (MAPA_DESPESAS / MAPA_INSUMOS / GRUPO_FINANCEIRO). Trazer pra uma tabela
-- permite que o financeiro reclassifique sem deploy (Fase 3 — tela de gestao).
--
-- O seed inicial replica o mapping atual do DRE. Naturezas novas que aparecam
-- na SE2 e nao estejam aqui caem como tipo=DESPESA, classificacao=FIXO,
-- operacional=TRUE (default seguro pra nao quebrar somatorios).

CREATE TABLE IF NOT EXISTS tab_natureza_classificacao (
    id              SERIAL PRIMARY KEY,
    natureza        VARCHAR(20) NOT NULL UNIQUE,
    descricao       VARCHAR(120),
    tipo            VARCHAR(10) NOT NULL CHECK (tipo IN ('CUSTO','DESPESA','RECEITA')),
    classificacao   VARCHAR(10) CHECK (classificacao IN ('VARIAVEL','FIXO')),
    operacional     BOOLEAN NOT NULL DEFAULT TRUE,
    obs             TEXT,
    criado_em       TIMESTAMP NOT NULL DEFAULT NOW(),
    atualizado_em   TIMESTAMP NOT NULL DEFAULT NOW(),
    atualizado_por  INT REFERENCES tab_intranet_usr(id) ON DELETE SET NULL
);

COMMENT ON TABLE tab_natureza_classificacao IS
    'Classificacao gerencial das naturezas financeiras do Protheus. Usada pelo dashboard de Receita e pelo DRE.';
COMMENT ON COLUMN tab_natureza_classificacao.natureza IS
    'Codigo da natureza (E2_NATUREZ no Protheus) — pode ser 3 chars (prefixo) ou completo. Match faz LEFT(E2_NATUREZ, length(natureza)).';
COMMENT ON COLUMN tab_natureza_classificacao.tipo IS
    'CUSTO (entra em CMV/saidas variaveis), DESPESA (despesa operacional) ou RECEITA.';
COMMENT ON COLUMN tab_natureza_classificacao.classificacao IS
    'VARIAVEL (escala com volume) ou FIXO (custo periodico). Null pra RECEITA.';
COMMENT ON COLUMN tab_natureza_classificacao.operacional IS
    'true = operacional (entra na margem operacional). false = nao operacional (financeiro, ganhos extraordinarios).';

-- Seed: espelha o MAPA_DESPESAS / MAPA_INSUMOS / GRUPO_FINANCEIRO do dre.js.
-- Operador pode reclassificar pela tela de gestao depois (Fase 3).
INSERT INTO tab_natureza_classificacao (natureza, descricao, tipo, classificacao, operacional)
VALUES
    ('201', 'Materia-Prima Nacional',   'CUSTO',   'VARIAVEL', TRUE),
    ('202', 'Materia-Prima Importada',  'CUSTO',   'VARIAVEL', TRUE),
    ('203', 'Desembaraco Aduaneiro',    'CUSTO',   'VARIAVEL', TRUE),
    ('204', 'Servicos Tomados',         'DESPESA', 'VARIAVEL', TRUE),
    ('205', 'Despesas com Pessoal',     'DESPESA', 'FIXO',     TRUE),
    ('206', 'Despesas Gerais',          'DESPESA', 'FIXO',     TRUE),
    ('207', 'Despesas Administrativas', 'DESPESA', 'FIXO',     TRUE),
    ('208', 'Impostos',                 'DESPESA', 'VARIAVEL', TRUE),
    ('210', 'Investimentos',            'DESPESA', 'FIXO',     TRUE),
    ('211', 'Financeiro',               'DESPESA', 'VARIAVEL', FALSE),
    ('212', 'Socios',                   'DESPESA', 'FIXO',     TRUE),
    ('213', 'Imobilizado/Consorcio',    'DESPESA', 'FIXO',     TRUE)
ON CONFLICT (natureza) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_nat_classif_tipo ON tab_natureza_classificacao (tipo);
