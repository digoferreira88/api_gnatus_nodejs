-- 127-cobranca-omni.sql
-- Módulo Cobrança Omni (financeira): a equipe sobe a planilha diária do portal Omni
-- (carteira em atraso) e trabalha os contratos na intranet; o trabalho (status,
-- agendamento, tags, ações) SEGUE o contrato entre uploads. Recompra (relatório
-- separado) usa as mesmas tabelas via coluna `tipo`.
-- 100% externo (não toca Protheus). Aplicar como postgres (ver GRANTs no fim).

-- 1) Cabeçalho de cada importação (upload de 1 arquivo)
CREATE TABLE IF NOT EXISTS tab_omni_import (
  id              SERIAL PRIMARY KEY,
  tipo            VARCHAR(12)   NOT NULL,            -- 'CARTEIRA' | 'RECOMPRA'
  arquivo_nome    TEXT,
  data_ref        DATE          NOT NULL,            -- carteira: data da extração; recompra: data final do período
  periodo_ini     DATE,
  periodo_fim     DATE,
  total_contratos INT           DEFAULT 0,
  total_atrasado  NUMERIC(14,2) DEFAULT 0,
  total_recebido  NUMERIC(14,2) DEFAULT 0,
  novos           INT           DEFAULT 0,
  sairam          INT           DEFAULT 0,
  criado_por      TEXT,
  criado_em       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_omni_import_tipo_data ON tab_omni_import (tipo, data_ref DESC);

-- 2) Posição de cada contrato NAQUELA importação (fatos do dia; histórico/aging)
CREATE TABLE IF NOT EXISTS tab_omni_posicao (
  id                   BIGSERIAL PRIMARY KEY,
  import_id            INT NOT NULL REFERENCES tab_omni_import(id) ON DELETE CASCADE,
  tipo                 VARCHAR(12) NOT NULL,
  data_ref             DATE        NOT NULL,
  contrato             VARCHAR(20) NOT NULL,
  cpf                  VARCHAR(20),
  cliente              TEXT,
  cidade_uf            VARCHAR(80),
  produto              VARCHAR(60),
  parcela              VARCHAR(12),                  -- "10/24"
  atraso_dias          INT,
  faixa                VARCHAR(20),                  -- '1 a 30' | '31 a 60' | '61 a 90'
  valor_atrasado       NUMERIC(14,2),
  valor_recebido_mes   NUMERIC(14,2),
  pct_recebido         NUMERIC(9,2),
  dias_sem_acionamento INT,
  situacao_portal      VARCHAR(60),                  -- situação do portal (ex.: BOLETO EMITIDO) — só leitura
  score                VARCHAR(4),                   -- A/B/C/D
  pdd_fechamento       NUMERIC(14,2),
  telefone             VARCHAR(30),
  -- específicos de RECOMPRA:
  emissao              DATE,
  proposta             VARCHAR(20),
  vlr_financiado       NUMERIC(14,2),
  vlr_liquido          NUMERIC(14,2),
  data_recompra        DATE,
  valor_recompra       NUMERIC(14,2)
);
CREATE INDEX IF NOT EXISTS ix_omni_pos_import   ON tab_omni_posicao (import_id);
CREATE INDEX IF NOT EXISTS ix_omni_pos_contrato ON tab_omni_posicao (contrato);
CREATE INDEX IF NOT EXISTS ix_omni_pos_data     ON tab_omni_posicao (tipo, data_ref DESC);

-- 3) Camada de TRABALHO da equipe (persistente, 1 linha por contrato — segue o contrato)
CREATE TABLE IF NOT EXISTS tab_omni_contrato (
  contrato          VARCHAR(20) PRIMARY KEY,
  tipo              VARCHAR(12),
  cpf               VARCHAR(20),
  cliente           TEXT,
  status            VARCHAR(40) DEFAULT '',          -- status oficial da cobrança (services/omniStatus)
  tags              JSONB       DEFAULT '[]'::jsonb,
  agendamento_data  DATE,
  agendamento_obs   TEXT,
  na_carteira       BOOLEAN     DEFAULT TRUE,         -- ainda está na última importação?
  primeiro_em       DATE,
  ultimo_em         DATE,
  saiu_em           DATE,
  atualizado_por    TEXT,
  criado_em         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_omni_contrato_status ON tab_omni_contrato (status);
CREATE INDEX IF NOT EXISTS ix_omni_contrato_cart   ON tab_omni_contrato (na_carteira);

-- 4) Histórico de AÇÕES / observações por contrato
CREATE TABLE IF NOT EXISTS tab_omni_acao (
  id               BIGSERIAL PRIMARY KEY,
  contrato         VARCHAR(20) NOT NULL,
  texto            TEXT,
  status_anterior  VARCHAR(40),
  status_novo      VARCHAR(40),
  agendamento_data DATE,
  autor            TEXT,
  id_user          INT REFERENCES tab_intranet_usr(id),
  concluida        BOOLEAN     DEFAULT FALSE,
  concluida_em     TIMESTAMPTZ,
  concluida_por    TEXT,
  criado_em        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_omni_acao_contrato ON tab_omni_acao (contrato, criado_em DESC);
CREATE INDEX IF NOT EXISTS ix_omni_acao_agenda   ON tab_omni_acao (agendamento_data) WHERE concluida = FALSE;

-- Permissões no catálogo (idempotente)
INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo)
SELECT 9007, 'Cobrança Omni - Painel', 'Cobrança'
 WHERE NOT EXISTS (SELECT 1 FROM tab_intranet_permissoes WHERE id_permissao = 9007);
INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo)
SELECT 9008, 'Cobrança Omni - Importar planilha', 'Cobrança'
 WHERE NOT EXISTS (SELECT 1 FROM tab_intranet_permissoes WHERE id_permissao = 9008);

-- Concede ao admin (p/ operar/testar de imediato)
INSERT INTO tab_intranet_usr_permissoes (id_user, id_permissao, matricula)
SELECT u.id, 9007, u.matricula FROM tab_intranet_usr u WHERE u.email = 'admin@gnatus.com.br'
ON CONFLICT (id_user, id_permissao) DO NOTHING;
INSERT INTO tab_intranet_usr_permissoes (id_user, id_permissao, matricula)
SELECT u.id, 9008, u.matricula FROM tab_intranet_usr u WHERE u.email = 'admin@gnatus.com.br'
ON CONFLICT (id_user, id_permissao) DO NOTHING;

-- GRANTs obrigatórios p/ o role `intranet` (migration roda como postgres). Idempotentes.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE tab_omni_import   TO intranet;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE tab_omni_posicao  TO intranet;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE tab_omni_contrato TO intranet;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE tab_omni_acao     TO intranet;
GRANT USAGE, SELECT ON SEQUENCE tab_omni_import_id_seq  TO intranet;
GRANT USAGE, SELECT ON SEQUENCE tab_omni_posicao_id_seq TO intranet;
GRANT USAGE, SELECT ON SEQUENCE tab_omni_acao_id_seq    TO intranet;
