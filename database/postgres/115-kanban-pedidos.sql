-- Kanban de Gestão de Pedidos (Pós-Venda / Customer Success) — Fase 1.
-- Solicitante: Aline (Gestão de Pós-Venda). Análise completa no documento
-- "Kanban de Gestão de Pedidos — viabilidade e proposta" (17/09/2026).
--
-- O painel é LEITURA: etapa e datas vêm do Protheus (SC5/SC6/SC9/SF2/SZ1) e a
-- entrega vem da Datafrete. A intranet guarda só o que o Protheus não tem:
--   - SLA de cada etapa (configurável pela área)
--   - parâmetros do painel (limite da Curva A, período padrão, % do amarelo)
--   - cache das entregas da Datafrete (a API limita cada consulta a 5 dias;
--     consultar a cada abertura do painel seria inviável)
--
-- Perm 6004 = ver o Kanban · 6005 = configurar SLA e parâmetros. Admin (0) faz tudo.

-- ---------------------------------------------------------------------------
-- SLA por etapa. Defaults = prazo em que 75% dos pedidos faturados em 2026 já
-- passavam pela etapa, arredondado para cima (medido em 17/09/2026):
--   comercial p75 111,7h -> 120h · financeiro 167,5h -> 168h · planejamento 68,1h -> 72h
--   formulação 3,5h -> 4h · estoque 64,5h -> 72h · faturamento 25,8h -> 48h
--   expedição 84h -> 96h · transporte 180h -> 192h
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tab_kanban_pedido_sla (
  etapa          VARCHAR(20)  PRIMARY KEY,
  nome           VARCHAR(60)  NOT NULL,
  ordem          SMALLINT     NOT NULL,
  sla_horas      NUMERIC(8,1) NOT NULL CHECK (sla_horas > 0),
  atualizado_em  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  atualizado_por INTEGER
);

INSERT INTO tab_kanban_pedido_sla (etapa, nome, ordem, sla_horas) VALUES
  ('comercial',    'Liberação comercial',            1, 120),
  ('financeiro',   'Análise financeira',             2, 168),
  ('planejamento', 'Liberação de planejamento',      3,  72),
  ('formulacao',   'Formulação financeira',          4,   4),
  ('estoque',      'Liberação de estoque',           5,  72),
  ('faturamento',  'Aguardando faturamento',         6,  48),
  ('expedicao',    'Faturado, aguardando expedição', 7,  96),
  ('transporte',   'Em transporte',                  8, 192)
ON CONFLICT (etapa) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Parâmetros do painel (chave/valor).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tab_kanban_pedido_config (
  chave          VARCHAR(40)  PRIMARY KEY,
  valor          VARCHAR(200) NOT NULL,
  atualizado_em  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  atualizado_por INTEGER
);

INSERT INTO tab_kanban_pedido_config (chave, valor) VALUES
  ('curva_a_valor',        '60000'),   -- pedido >= este valor = Curva A (dourado)
  ('periodo_padrao_dias',  '90'),      -- janela de emissão aberta por padrão
  ('amarelo_pct',          '80')       -- % do SLA a partir do qual o card fica amarelo
ON CONFLICT (chave) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Entregas da Datafrete, uma linha por NF (chave de 44 dígitos).
-- dt_evento é o horário local informado pela transportadora (sem fuso).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tab_nf_entrega (
  chave_nf       VARCHAR(44)  PRIMARY KEY,
  numero_nf      VARCHAR(20),
  serie_nf       VARCHAR(5),
  entregue       BOOLEAN      NOT NULL DEFAULT false,
  dt_evento      TIMESTAMP,              -- data da entrega (entregue) ou do último evento
  descricao      VARCHAR(300),
  primeiro_visto TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  atualizado_em  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_nf_entrega_entregue ON tab_nf_entrega (entregue);

-- Estado da sincronização (última execução, erro), para o painel avisar se parou.
CREATE TABLE IF NOT EXISTS tab_nf_entrega_sync (
  id             SMALLINT     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  ultima_ok      TIMESTAMPTZ,
  ultima_tentativa TIMESTAMPTZ,
  ultimo_erro    VARCHAR(300),
  nfs_na_ultima  INTEGER
);
INSERT INTO tab_nf_entrega_sync (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Catálogo de permissões (tela Editar Permissões, módulo SAC).
-- ---------------------------------------------------------------------------
INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo) VALUES
  (6004, 'SAC - Kanban de Pedidos (Pós-venda)', 'SAC'),
  (6005, 'SAC - Kanban de Pedidos - configurar SLA', 'SAC')
ON CONFLICT (id_permissao) DO NOTHING;
