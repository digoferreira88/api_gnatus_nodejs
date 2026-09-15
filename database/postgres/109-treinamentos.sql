-- Módulo de Gestão e Inscrição em Treinamentos Corporativos (setor Educacional).
-- Treinamento 1─N sessões (cada sessão com data/hora/local/capacidade própria) 1─N inscrições.
-- Presencial consome vaga (contador atômico `ocupadas`); Online é ilimitado.
-- Perm 20001 = administração (setor Educacional); ver/inscrever = qualquer autenticado.

CREATE TABLE IF NOT EXISTS tab_treina_treinamento (
  id                   SERIAL PRIMARY KEY,
  titulo               VARCHAR(160) NOT NULL,
  descricao            TEXT,
  objetivo             TEXT,
  instrutor            VARCHAR(160),
  setor_responsavel    VARCHAR(120),
  local_padrao         VARCHAR(160),
  teams_link           VARCHAR(500),                 -- link online único do treinamento (sessão pode sobrescrever)
  modalidades          VARCHAR(12) NOT NULL DEFAULT 'ambas',   -- 'presencial' | 'online' | 'ambas'
  status               VARCHAR(12) NOT NULL DEFAULT 'rascunho',-- rascunho | publicado | encerrado | cancelado
  permite_cancelamento BOOLEAN NOT NULL DEFAULT true,
  permite_troca_sessao BOOLEAN NOT NULL DEFAULT true,
  criado_por           INTEGER,
  criado_em            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_treina_status CHECK (status IN ('rascunho','publicado','encerrado','cancelado')),
  CONSTRAINT chk_treina_modal  CHECK (modalidades IN ('presencial','online','ambas'))
);

CREATE TABLE IF NOT EXISTS tab_treina_sessao (
  id             SERIAL PRIMARY KEY,
  treinamento_id INTEGER NOT NULL REFERENCES tab_treina_treinamento(id) ON DELETE CASCADE,
  data           DATE NOT NULL,
  hora_inicio    VARCHAR(5),                    -- 'HH:MM'
  hora_fim       VARCHAR(5),
  local          VARCHAR(160),                  -- override do local_padrao
  teams_link     VARCHAR(500),                  -- override do link do treinamento
  capacidade     INTEGER NOT NULL DEFAULT 0,    -- vagas PRESENCIAIS
  ocupadas       INTEGER NOT NULL DEFAULT 0,    -- contador atômico de presenciais ativos
  status         VARCHAR(12) NOT NULL DEFAULT 'agendada',  -- agendada | cancelada
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_sessao_status CHECK (status IN ('agendada','cancelada')),
  CONSTRAINT chk_sessao_cap    CHECK (capacidade >= 0),
  CONSTRAINT chk_sessao_ocup   CHECK (ocupadas >= 0 AND ocupadas <= capacidade)
);
CREATE INDEX IF NOT EXISTS ix_treina_sessao_trein ON tab_treina_sessao (treinamento_id);

CREATE TABLE IF NOT EXISTS tab_treina_inscricao (
  id                SERIAL PRIMARY KEY,
  treinamento_id    INTEGER NOT NULL REFERENCES tab_treina_treinamento(id) ON DELETE CASCADE,
  sessao_id         INTEGER NOT NULL REFERENCES tab_treina_sessao(id) ON DELETE CASCADE,
  colaborador_id    INTEGER NOT NULL,           -- tab_intranet_usr.id
  colaborador_nome  VARCHAR(200),
  colaborador_email VARCHAR(200),
  departamento      VARCHAR(120),
  cargo             VARCHAR(120),
  modalidade        VARCHAR(12) NOT NULL,       -- presencial | online
  status            VARCHAR(12) NOT NULL DEFAULT 'ativa',  -- ativa | cancelada
  calendar_event_id VARCHAR(300),               -- id do evento no calendário M365 (p/ update/cancel)
  criado_em         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancelado_em      TIMESTAMPTZ,
  cancelado_por     INTEGER,
  CONSTRAINT chk_insc_modal  CHECK (modalidade IN ('presencial','online')),
  CONSTRAINT chk_insc_status CHECK (status IN ('ativa','cancelada'))
);
-- 1 inscrição ATIVA por (treinamento, colaborador) — anti-duplicidade à prova de corrida.
-- Como o INSERT e o incremento de `ocupadas` são 1 único statement (CTE), a violação
-- deste índice desfaz o incremento automaticamente (rollback do statement).
CREATE UNIQUE INDEX IF NOT EXISTS ux_treina_insc_ativa
  ON tab_treina_inscricao (treinamento_id, colaborador_id) WHERE status = 'ativa';
CREATE INDEX IF NOT EXISTS ix_treina_insc_sessao ON tab_treina_inscricao (sessao_id, status);
CREATE INDEX IF NOT EXISTS ix_treina_insc_colab  ON tab_treina_inscricao (colaborador_id, status);

GRANT SELECT, INSERT, UPDATE, DELETE ON tab_treina_treinamento, tab_treina_sessao, tab_treina_inscricao TO intranet;
GRANT USAGE, SELECT ON SEQUENCE tab_treina_treinamento_id_seq, tab_treina_sessao_id_seq, tab_treina_inscricao_id_seq TO intranet;
