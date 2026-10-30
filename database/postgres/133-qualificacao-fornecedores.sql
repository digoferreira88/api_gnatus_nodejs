-- 133 — Qualificação e Avaliação de Fornecedores
--
-- Base: PRO 7.3.7 — Qualificação de Fornecedor, REV OUT261 (29/10/2026), FORM 7.3.21
-- REV OUT26 (Cadastro e Avaliação de Fornecedores), FORM 7.3.24 (Lista de Qualificação
-- de Fornecedores — Monitoramento), FORM 7.4.3.H (Relatório de Inspeção de Recebimento)
-- e FORM 7.3.28 (Requalificação de Fornecedores). Referência normativa do PRO:
-- ABNT NBR ISO 13485:2016 req. 4.2.4; RDC 665/2022 art. 28 a 37.
--
-- Decisões embutidas no desenho:
--   - O fornecedor é o do Protheus: chave = A2_COD (6 dígitos). Antes de existir no ERP
--     ganha código provisório "P00001". O módulo guarda a camada de qualificação + um
--     retrato do cadastro (SA2 é só LIDA, nunca escrita).
--   - Criticidade é do ITEM que o fornecedor fornece (lista de itens e serviços críticos,
--     tab_qf_item_critico). O fornecedor tem o CONJUNTO das criticidades dos itens dele
--     (A matéria-prima · B dispositivo médico com registro/notificação · C dispositivo sem
--     registro · D serviço crítico). Conjunto vazio = não crítico (não exige qualificação
--     prévia e não entra no monitoramento do IQF, mas o recebimento continua registrado).
--   - Regras (C, P, N, classes, questionário, amostragem, requalificação) em JSON
--     VERSIONADO e imutável. Ativa: PRO 7.3.7 REV OUT261. A da planilha fica para o
--     histórico importado (cada inspeção aponta a versão com que foi calculada).
--   - Inspeção e documento nunca são apagados (exclusão lógica com motivo).
--   - tab_qf_log é a trilha campo a campo, somente inclusão (trigger + GRANT).
--   - "VENCIDO" de documento é derivado da validade na consulta.
--
-- Aplicar como postgres (GRANTs no fim). Idempotente.

-- ---------------------------------------------------------------- regras (versionadas)
CREATE TABLE IF NOT EXISTS tab_qf_regra_versao (
  id           SERIAL PRIMARY KEY,
  nome         VARCHAR(120) NOT NULL,
  referencia   VARCHAR(160),
  descricao    TEXT,
  conteudo     JSONB NOT NULL,
  ativa        BOOLEAN NOT NULL DEFAULT FALSE,
  criado_por   INTEGER,
  criado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ativada_por  INTEGER,
  ativada_em   TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_qf_regra_ativa ON tab_qf_regra_versao ((ativa)) WHERE ativa;

CREATE OR REPLACE FUNCTION fn_qf_regra_imutavel() RETURNS trigger AS $$
BEGIN
  IF NEW.conteudo IS DISTINCT FROM OLD.conteudo THEN
    RAISE EXCEPTION 'tab_qf_regra_versao: o conteúdo de uma versão de regra não pode ser alterado — crie uma nova versão.';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS tg_qf_regra_imutavel ON tab_qf_regra_versao;
CREATE TRIGGER tg_qf_regra_imutavel BEFORE UPDATE ON tab_qf_regra_versao
  FOR EACH ROW EXECUTE FUNCTION fn_qf_regra_imutavel();

-- ---------------------------------------------------------------- lista de itens e serviços críticos (PRO 5.2)
CREATE TABLE IF NOT EXISTS tab_qf_item_critico (
  id              SERIAL PRIMARY KEY,
  produto         VARCHAR(30) NOT NULL,          -- B1_COD (ou código do serviço)
  produto_chave   VARCHAR(30) NOT NULL UNIQUE,   -- sem zeros à esquerda (planilha gravava "12614", Protheus "012614")
  descricao       VARCHAR(200),
  criticidade     CHAR(1) NOT NULL,              -- A | B | C | D
  observacao      TEXT,
  ativo           BOOLEAN NOT NULL DEFAULT TRUE,
  atualizado_por  INTEGER,
  atualizado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_qf_item_crit CHECK (criticidade IN ('A','B','C','D'))
);

-- ---------------------------------------------------------------- fornecedor
CREATE TABLE IF NOT EXISTS tab_qf_fornecedor (
  id                       SERIAL PRIMARY KEY,
  codigo                   VARCHAR(6) NOT NULL UNIQUE,
  loja                     VARCHAR(4),
  razao_social             VARCHAR(200) NOT NULL,
  nome_fantasia            VARCHAR(120),
  cnpj                     VARCHAR(20),
  pais                     VARCHAR(60) DEFAULT 'Brasil',
  nacional                 BOOLEAN NOT NULL DEFAULT TRUE,   -- importado: P pela data de COLETA (PRO 5.9)
  endereco                 VARCHAR(200),
  cidade                   VARCHAR(80),
  estado                   VARCHAR(2),
  cep                      VARCHAR(10),
  contato_nome             VARCHAR(120),
  contato_email            VARCHAR(200),
  contato_telefone         VARCHAR(40),

  tipo_fornecimento        VARCHAR(12),                     -- MP | SERVICO | MP_SERVICO | PRODUTO (acabado/revenda)
  criticidades             VARCHAR(1)[] NOT NULL DEFAULT '{}',
  status_qualificacao      VARCHAR(24) NOT NULL DEFAULT 'EM_QUALIFICACAO',
  suspensao_tipo           VARCHAR(16),                     -- PLANO_ACAO_C | PLANO_ACAO_D | DOCUMENTO | REQUALIFICACAO | MANUAL
  motivo_suspensao         TEXT,
  suspenso_em              TIMESTAMPTZ,

  -- "Avaliação do SGQ" da FORM 7.3.24 (SIM | NAO | NA)
  sgq_bpf                  VARCHAR(3),
  sgq_iso13485             VARCHAR(3),
  sgq_iso9001              VARCHAR(3),
  sgq_acordo               VARCHAR(3),
  sgq_questionario         VARCHAR(3),
  nota_sgq                 NUMERIC(6,2),

  -- IQF materializado (recalculado a cada inspeção incluída/alterada/excluída)
  iqf_medio                NUMERIC(8,4),
  qtd_inspecoes            INTEGER NOT NULL DEFAULT 0,
  classificacao            CHAR(1),                         -- só fornecedor crítico (monitorado)
  ultima_inspecao          DATE,
  iqf_atualizado_em        TIMESTAMPTZ,
  auditoria_sugerida_motivo TEXT,                           -- gatilhos do PRO 5.6.2 (IQF < 7 duas vezes, NCs recorrentes)
  iqf_desde                DATE,                            -- reaprovado após reprovação: a média recomeça nesta data (histórico fica visível)

  -- plano de ação exigido nas classes C e D (registrado pela Engenharia)
  plano_acao_iqf           TEXT,
  plano_acao_iqf_em        TIMESTAMPTZ,
  plano_acao_iqf_por       INTEGER,
  inspecao_100             BOOLEAN NOT NULL DEFAULT FALSE,  -- classe D: só recebimento 100% (sem amostragem)

  -- qualificação e requalificação anual (PRO 5.10)
  data_aprovacao           TIMESTAMPTZ,
  aprovado_por             INTEGER,
  qualificacao_valida_ate  DATE,

  data_cadastro            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  observacoes              TEXT,
  bloqueado_protheus       BOOLEAN,
  ativo                    BOOLEAN NOT NULL DEFAULT TRUE,   -- inativo: some das listas e do recebimento
  origem                   VARCHAR(16) NOT NULL DEFAULT 'INTRANET',  -- INTRANET | PLANILHA_7324 | PLANILHA_743H | SA2
  legado                   BOOLEAN NOT NULL DEFAULT FALSE,
  pendencias               TEXT[],
  criado_por               INTEGER,
  atualizado_por           INTEGER,
  atualizado_em            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT ck_qf_forn_crit   CHECK (criticidades <@ ARRAY['A','B','C','D']::VARCHAR(1)[]),
  CONSTRAINT ck_qf_forn_status CHECK (status_qualificacao IN ('EM_QUALIFICACAO','APROVADO','APROVADO_COM_RESTRICAO','REPROVADO','SUSPENSO')),
  CONSTRAINT ck_qf_forn_tipo   CHECK (tipo_fornecimento IS NULL OR tipo_fornecimento IN ('MP','SERVICO','MP_SERVICO','PRODUTO')),
  CONSTRAINT ck_qf_forn_class  CHECK (classificacao IS NULL OR classificacao IN ('A','B','C','D','E')),
  CONSTRAINT ck_qf_forn_susp   CHECK (suspensao_tipo IS NULL OR suspensao_tipo IN ('PLANO_ACAO_C','PLANO_ACAO_D','DOCUMENTO','REQUALIFICACAO','MANUAL'))
);
CREATE INDEX IF NOT EXISTS ix_qf_forn_razao  ON tab_qf_fornecedor (razao_social);
CREATE INDEX IF NOT EXISTS ix_qf_forn_status ON tab_qf_fornecedor (status_qualificacao);
CREATE INDEX IF NOT EXISTS ix_qf_forn_crit   ON tab_qf_fornecedor USING GIN (criticidades);
CREATE INDEX IF NOT EXISTS ix_qf_forn_valid  ON tab_qf_fornecedor (qualificacao_valida_ate) WHERE cardinality(criticidades) > 0;

-- ---------------------------------------------------------------- anexos (blob único do módulo)
CREATE TABLE IF NOT EXISTS tab_qf_anexo (
  id                   SERIAL PRIMARY KEY,
  entidade             VARCHAR(20) NOT NULL,     -- fornecedor | documento | inspecao | auditoria | amostra | avaliacao | qualificacao | ficha
  entidade_id          INTEGER NOT NULL,
  fornecedor_id        INTEGER REFERENCES tab_qf_fornecedor(id),
  categoria            VARCHAR(20) NOT NULL DEFAULT 'OUTRO',   -- FOTO | LAUDO | RNC | RELATORIO | DOCUMENTO | PLANO_ACAO | OUTRO
  nome_arquivo         VARCHAR(255) NOT NULL,
  mime_type            VARCHAR(120),
  tamanho_bytes        INTEGER,
  sha256               CHAR(64),
  conteudo             BYTEA NOT NULL,
  descricao            VARCHAR(255),
  excluido             BOOLEAN NOT NULL DEFAULT FALSE,
  excluido_motivo      TEXT,
  excluido_por         INTEGER,
  excluido_em          TIMESTAMPTZ,
  enviado_por          INTEGER,
  enviado_por_externo  VARCHAR(200),             -- fornecedor pelo link público (nome <e-mail>)
  enviado_em           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_qf_anexo_ent ON tab_qf_anexo (entidade, entidade_id) WHERE NOT excluido;

-- ---------------------------------------------------------------- documentos (PRO 5.3 / FORM 7.3.21 REV OUT26)
CREATE TABLE IF NOT EXISTS tab_qf_tipo_documento (
  id               SERIAL PRIMARY KEY,
  codigo           VARCHAR(40) NOT NULL UNIQUE,
  nome             VARCHAR(220) NOT NULL,
  regra_a          VARCHAR(12),   -- OBRIGATORIO | CONDICIONAL | NULL (não se aplica)
  regra_b          VARCHAR(12),
  regra_c          VARCHAR(12),
  regra_d          VARCHAR(12),
  somente_nacional BOOLEAN NOT NULL DEFAULT TRUE,
  condicao         VARCHAR(220),
  exige_validade   BOOLEAN NOT NULL DEFAULT FALSE,
  gerado_sistema   BOOLEAN NOT NULL DEFAULT FALSE,   -- FORM 7.3.21: atendido pela ficha analisada no módulo
  ordem            INTEGER NOT NULL DEFAULT 0,
  ativo            BOOLEAN NOT NULL DEFAULT TRUE,
  atualizado_por   INTEGER,
  atualizado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_qf_tipodoc_regra CHECK (
    (regra_a IS NULL OR regra_a IN ('OBRIGATORIO','CONDICIONAL')) AND (regra_b IS NULL OR regra_b IN ('OBRIGATORIO','CONDICIONAL')) AND
    (regra_c IS NULL OR regra_c IN ('OBRIGATORIO','CONDICIONAL')) AND (regra_d IS NULL OR regra_d IN ('OBRIGATORIO','CONDICIONAL')))
);

CREATE TABLE IF NOT EXISTS tab_qf_documento (
  id                   SERIAL PRIMARY KEY,
  fornecedor_id        INTEGER NOT NULL REFERENCES tab_qf_fornecedor(id),
  tipo_documento_id    INTEGER NOT NULL REFERENCES tab_qf_tipo_documento(id),
  numero               VARCHAR(80),
  data_emissao         DATE,
  data_validade        DATE,
  status               VARCHAR(12) NOT NULL DEFAULT 'VIGENTE',  -- VIGENTE | PROTOCOLADO | DISPENSADO | SUBSTITUIDO | EXCLUIDO
  prazo_regularizacao  DATE,                     -- PROTOCOLADO: data definida p/ envio do documento (PRO 5.4)
  anexo_id             INTEGER REFERENCES tab_qf_anexo(id),
  origem               VARCHAR(12) NOT NULL DEFAULT 'INTERNO',  -- INTERNO | FORNECEDOR (enviado no FORM) | LEGADO
  justificativa        TEXT,
  observacoes          TEXT,
  aprovado_por         INTEGER,
  aprovado_em          TIMESTAMPTZ,
  aviso_30_em          TIMESTAMPTZ,
  aviso_1_em           TIMESTAMPTZ,
  aviso_vencido_em     TIMESTAMPTZ,
  enviado_por          INTEGER,
  enviado_em           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_por       INTEGER,
  atualizado_em        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_qf_doc_status CHECK (status IN ('VIGENTE','PROTOCOLADO','DISPENSADO','SUBSTITUIDO','EXCLUIDO'))
);
CREATE INDEX IF NOT EXISTS ix_qf_doc_forn ON tab_qf_documento (fornecedor_id, tipo_documento_id);
CREATE INDEX IF NOT EXISTS ix_qf_doc_val  ON tab_qf_documento (data_validade) WHERE status IN ('VIGENTE','PROTOCOLADO');

-- ---------------------------------------------------------------- processo de qualificação / requalificação
CREATE TABLE IF NOT EXISTS tab_qf_qualificacao (
  id                       SERIAL PRIMARY KEY,
  fornecedor_id            INTEGER NOT NULL REFERENCES tab_qf_fornecedor(id),
  tipo                     VARCHAR(16) NOT NULL DEFAULT 'INICIAL',      -- INICIAL | REQUALIFICACAO | REATIVACAO
  etapa                    VARCHAR(20) NOT NULL DEFAULT 'CRITICIDADE',
  status                   VARCHAR(16) NOT NULL DEFAULT 'EM_ANDAMENTO', -- EM_ANDAMENTO | PAUSADO | APROVADO | REPROVADO | CANCELADO
  criticidade_definida     BOOLEAN NOT NULL DEFAULT FALSE,
  auditoria_necessaria     BOOLEAN,                    -- decisão da Engenharia (PRO 4.1), com justificativa (Nota do 5.6)
  auditoria_justificativa  TEXT,
  amostra_dispensada       BOOLEAN NOT NULL DEFAULT FALSE,
  amostra_justificativa    TEXT,
  analise                  JSONB NOT NULL DEFAULT '{}'::jsonb,  -- requalificação: análise documental, desempenho e alterações (PRO 5.10.1)
  plano_acao               TEXT,                       -- resultados "com restrição"
  prazo_regularizacao      DATE,
  vencimento_anterior      DATE,                       -- requalificação: validade que estava em vigor
  motivo                   TEXT,
  iniciado_por             INTEGER,
  iniciado_em              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  concluido_em             TIMESTAMPTZ,
  -- assinatura eletrônica do gerente de engenharia (senha reconfirmada no ato)
  aprovacao_resultado      VARCHAR(28),
  aprovacao_por            INTEGER,
  aprovacao_nome           VARCHAR(120),
  aprovacao_em             TIMESTAMPTZ,
  aprovacao_ip             VARCHAR(60),
  aprovacao_declaracao     TEXT,
  aprovacao_hash           CHAR(64),
  atualizado_por           INTEGER,
  atualizado_em            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_qf_qual_tipo   CHECK (tipo IN ('INICIAL','REQUALIFICACAO','REATIVACAO')),
  CONSTRAINT ck_qf_qual_status CHECK (status IN ('EM_ANDAMENTO','PAUSADO','APROVADO','REPROVADO','CANCELADO'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_qf_qual_aberta ON tab_qf_qualificacao (fornecedor_id) WHERE status IN ('EM_ANDAMENTO','PAUSADO');

-- ---------------------------------------------------------------- FORM 7.3.21 / 7.3.28 — fichas e questionário
CREATE TABLE IF NOT EXISTS tab_qf_pergunta (
  id            SERIAL PRIMARY KEY,
  codigo        VARCHAR(20) NOT NULL UNIQUE,
  secao         VARCHAR(160),
  texto         TEXT NOT NULL,
  ajuda         TEXT,                                    -- orientação ao fornecedor (texto em azul do FORM)
  ordem         INTEGER NOT NULL DEFAULT 0,
  aplicavel_a   VARCHAR(12) NOT NULL DEFAULT 'TODOS',    -- TODOS | CRITICO_A | CRITICO_B | CRITICO_C | CRITICO_D
  ativo         BOOLEAN NOT NULL DEFAULT TRUE,
  atualizado_por INTEGER,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_qf_perg_aplic CHECK (aplicavel_a IN ('TODOS','CRITICO_A','CRITICO_B','CRITICO_C','CRITICO_D'))
);

CREATE TABLE IF NOT EXISTS tab_qf_ficha (
  id                    SERIAL PRIMARY KEY,
  fornecedor_id         INTEGER NOT NULL REFERENCES tab_qf_fornecedor(id),
  qualificacao_id       INTEGER REFERENCES tab_qf_qualificacao(id),
  formulario            VARCHAR(8) NOT NULL DEFAULT '7.3.21',   -- 7.3.21 (cadastro e avaliação) | 7.3.28 (requalificação)
  status                VARCHAR(12) NOT NULL DEFAULT 'RASCUNHO', -- RASCUNHO | ENVIADA | RESPONDIDA | DEVOLVIDA | ANALISADA
  token                 VARCHAR(64) UNIQUE,
  token_expira_em       TIMESTAMPTZ,
  enviada_em            TIMESTAMPTZ,
  enviada_para          VARCHAR(200),
  enviada_por           INTEGER,
  respondida_em         TIMESTAMPTZ,
  respondente_nome      VARCHAR(120),
  respondente_cargo     VARCHAR(120),
  respondente_email     VARCHAR(200),
  respondente_ip        VARCHAR(60),
  aceite                BOOLEAN NOT NULL DEFAULT FALSE,   -- assinatura eletrônica do fornecedor (declaração aceita)
  dados                 JSONB NOT NULL DEFAULT '{}'::jsonb, -- dados cadastrais, contatos, documentos declarados, alterações (7.3.28)
  pontuacao_total       NUMERIC(8,2),
  pontuacao_maxima      NUMERIC(8,2),
  pontuacao_percentual  NUMERIC(6,2),
  por_secao             JSONB,                             -- % por seção (gráfico do FORM)
  resultado             VARCHAR(28),                       -- 7.3.21: APROVADO | APROVADO_COM_RESTRICAO | REPROVADO · 7.3.28: REQUALIFICADO | REQUALIFICADO_COM_RESTRICAO | NAO_REQUALIFICADO
  regra_versao_id       INTEGER REFERENCES tab_qf_regra_versao(id),
  analisada_em          TIMESTAMPTZ,
  analisada_por         INTEGER,
  parecer               TEXT,
  plano_acao            TEXT,
  devolvida_motivo      TEXT,
  gerente_por           INTEGER,
  gerente_nome          VARCHAR(120),
  gerente_em            TIMESTAMPTZ,
  criado_por            INTEGER,
  criado_em             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_qf_ficha_status CHECK (status IN ('RASCUNHO','ENVIADA','RESPONDIDA','DEVOLVIDA','ANALISADA')),
  CONSTRAINT ck_qf_ficha_form   CHECK (formulario IN ('7.3.21','7.3.28'))
);
CREATE INDEX IF NOT EXISTS ix_qf_ficha_forn ON tab_qf_ficha (fornecedor_id, id DESC);

CREATE TABLE IF NOT EXISTS tab_qf_resposta (
  id               SERIAL PRIMARY KEY,
  ficha_id         INTEGER NOT NULL REFERENCES tab_qf_ficha(id) ON DELETE CASCADE,
  pergunta_id      INTEGER NOT NULL REFERENCES tab_qf_pergunta(id),
  pergunta_codigo  VARCHAR(20),
  pergunta_secao   VARCHAR(160),
  pergunta_texto   TEXT,
  alternativa      VARCHAR(8) NOT NULL,
  em_branco        BOOLEAN NOT NULL DEFAULT FALSE,   -- deixada em branco: vale NÃO (FORM 7.3.21)
  pontos           NUMERIC(4,1) NOT NULL,
  comprovacao      TEXT,
  respondido_em    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_qf_resp_alt CHECK (alternativa IN ('SIM','PARCIAL','NAO')),
  CONSTRAINT ux_qf_resp_unica UNIQUE (ficha_id, pergunta_id)
);

-- ---------------------------------------------------------------- auditoria em fornecedor (PRO 5.6)
CREATE TABLE IF NOT EXISTS tab_qf_auditoria (
  id                  SERIAL PRIMARY KEY,
  fornecedor_id       INTEGER NOT NULL REFERENCES tab_qf_fornecedor(id),
  qualificacao_id     INTEGER REFERENCES tab_qf_qualificacao(id),
  motivo_tipo         VARCHAR(16) NOT NULL DEFAULT 'INICIAL',  -- INICIAL (5.6.1) | ACOMPANHAMENTO (5.6.2) | REQUALIFICACAO
  tipo                VARCHAR(12) NOT NULL,          -- IN_LOCO | REMOTA | DOCUMENTAL
  status              VARCHAR(12) NOT NULL DEFAULT 'AGENDADA',
  data_agendada       DATE,
  data_realizada      DATE,
  auditor_id          INTEGER,
  auditor_nome        VARCHAR(120),
  escopo              TEXT,
  resultado           VARCHAR(28),
  plano_acao          TEXT,
  referencia_pro_822  BOOLEAN NOT NULL DEFAULT TRUE,
  observacoes         TEXT,
  criado_por          INTEGER,
  criado_em           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_por      INTEGER,
  atualizado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_qf_aud_tipo   CHECK (tipo IN ('IN_LOCO','REMOTA','DOCUMENTAL')),
  CONSTRAINT ck_qf_aud_motivo CHECK (motivo_tipo IN ('INICIAL','ACOMPANHAMENTO','REQUALIFICACAO')),
  CONSTRAINT ck_qf_aud_res    CHECK (resultado IS NULL OR resultado IN ('CONFORME','NAO_CONFORME','CONFORME_COM_OBSERVACOES'))
);

-- ---------------------------------------------------------------- amostra + avaliações (PRO 5.7 — FORM 7.3.22 / 7.3.23)
CREATE TABLE IF NOT EXISTS tab_qf_amostra (
  id                    SERIAL PRIMARY KEY,
  fornecedor_id         INTEGER NOT NULL REFERENCES tab_qf_fornecedor(id),
  qualificacao_id       INTEGER REFERENCES tab_qf_qualificacao(id),
  componente_codigo     VARCHAR(30),
  componente_descricao  VARCHAR(200),
  quantidade            NUMERIC(14,3),
  status                VARCHAR(12) NOT NULL DEFAULT 'SOLICITADA',
  data_solicitacao      DATE,
  data_recebimento      DATE,
  observacoes           TEXT,
  criado_por            INTEGER,
  criado_em             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_por        INTEGER,
  atualizado_em         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tab_qf_avaliacao (
  id                        SERIAL PRIMARY KEY,
  fornecedor_id             INTEGER NOT NULL REFERENCES tab_qf_fornecedor(id),
  qualificacao_id           INTEGER REFERENCES tab_qf_qualificacao(id),
  amostra_id                INTEGER REFERENCES tab_qf_amostra(id),
  tipo                      VARCHAR(12) NOT NULL,       -- DIMENSIONAL (7.3.22) | FUNCIONAL (7.3.23)
  componente_codigo         VARCHAR(30),
  componente_descricao      VARCHAR(200),
  data_recebimento_amostra  DATE,
  data_avaliacao            DATE,
  avaliado_por              INTEGER,
  avaliado_nome             VARCHAR(120),
  resultado                 VARCHAR(24),                -- APROVADO | APROVADO_COM_RESTRICAO | REPROVADO | NAO_APLICAVEL
  acordo_formal             TEXT,                       -- "com restrição" exige acordo formal (PRO 5.7.1/5.7.2)
  observacoes               TEXT,
  criado_por                INTEGER,
  criado_em                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_por            INTEGER,
  atualizado_em             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_qf_aval_tipo CHECK (tipo IN ('DIMENSIONAL','FUNCIONAL')),
  CONSTRAINT ck_qf_aval_res  CHECK (resultado IS NULL OR resultado IN ('APROVADO','APROVADO_COM_RESTRICAO','REPROVADO','NAO_APLICAVEL'))
);

CREATE TABLE IF NOT EXISTS tab_qf_avaliacao_item (
  id             SERIAL PRIMARY KEY,
  avaliacao_id   INTEGER NOT NULL REFERENCES tab_qf_avaliacao(id) ON DELETE CASCADE,
  ordem          INTEGER NOT NULL DEFAULT 0,
  caracteristica VARCHAR(200) NOT NULL,
  critico        BOOLEAN NOT NULL DEFAULT FALSE,   -- requisito crítico: não atendido = reprovado (PRO 5.7.1)
  nominal        VARCHAR(40),
  tolerancia     VARCHAR(40),
  medido         VARCHAR(80),
  unidade        VARCHAR(20),
  instrumento    VARCHAR(80),
  status         VARCHAR(14) NOT NULL DEFAULT 'CONFORME',
  CONSTRAINT ck_qf_aval_item_st CHECK (status IN ('CONFORME','NAO_CONFORME'))
);

-- ---------------------------------------------------------------- FORM 7.4.3.H — inspeção de recebimento
CREATE TABLE IF NOT EXISTS tab_qf_inspecao (
  id                     SERIAL PRIMARY KEY,
  rel_insp               INTEGER NOT NULL UNIQUE,     -- numeração contínua herdada da planilha
  fornecedor_id          INTEGER NOT NULL REFERENCES tab_qf_fornecedor(id),
  fornecedor_codigo      VARCHAR(6) NOT NULL,
  fornecedor_nome        VARCHAR(200),
  pedido_compras         VARCHAR(20),
  pedido_item            VARCHAR(4),
  cod_item               VARCHAR(30),
  descricao_item         VARCHAR(200),
  item_criticidade       CHAR(1),                     -- da lista de itens críticos no momento da inspeção
  nota_fiscal            VARCHAR(30),
  lote                   VARCHAR(60),
  nivel_inspecao         VARCHAR(4),                  -- I | II | III | 100
  qtd_recebida           NUMERIC(14,3),
  qtd_inspecionada       NUMERIC(14,3),
  qtd_aprovada           NUMERIC(14,3),
  qtd_reprovada          NUMERIC(14,3),
  especificacao          TEXT,
  criterio_aceitacao     TEXT,
  resultado_descricao    TEXT,
  instrumento_utilizado  VARCHAR(200),
  rnc_numero             VARCHAR(40),
  tipo_prazo             VARCHAR(8),                  -- ENTREGA (nacional) | COLETA (importado) — base do P
  data_entrega_prevista  DATE,                        -- D (entrega) ou DC (coleta), conforme tipo_prazo
  data_entrega_real      DATE,
  data_inspecao          DATE,
  dias_atraso            INTEGER,                     -- negativo = antecipação
  pct_conforme           NUMERIC(7,3),
  nc                     BOOLEAN NOT NULL DEFAULT FALSE,
  ncs_janela             INTEGER,
  indice_c               NUMERIC(5,2),
  indice_p               NUMERIC(4,2),
  indice_n               NUMERIC(4,2),
  iqf                    NUMERIC(8,4),
  c_manual               BOOLEAN NOT NULL DEFAULT FALSE,
  p_manual               BOOLEAN NOT NULL DEFAULT FALSE,
  n_manual               BOOLEAN NOT NULL DEFAULT FALSE,
  ajuste_justificativa   TEXT,
  bloqueio_justificativa TEXT,                        -- Qualidade registrou recebimento de fornecedor bloqueado
  regra_versao_id        INTEGER REFERENCES tab_qf_regra_versao(id),
  responsavel_id         INTEGER,
  responsavel_nome       VARCHAR(120),
  observacoes            TEXT,
  origem                 VARCHAR(10) NOT NULL DEFAULT 'INTRANET',
  legado_avisos          TEXT[],
  excluido               BOOLEAN NOT NULL DEFAULT FALSE,
  excluido_motivo        TEXT,
  excluido_por           INTEGER,
  excluido_em            TIMESTAMPTZ,
  criado_por             INTEGER,
  criado_em              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_por         INTEGER,
  atualizado_em          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_qf_insp_nivel CHECK (nivel_inspecao IS NULL OR nivel_inspecao IN ('I','II','III','100')),
  CONSTRAINT ck_qf_insp_prazo CHECK (tipo_prazo IS NULL OR tipo_prazo IN ('ENTREGA','COLETA'))
);
CREATE INDEX IF NOT EXISTS ix_qf_insp_forn_data ON tab_qf_inspecao (fornecedor_id, data_inspecao DESC, rel_insp DESC) WHERE NOT excluido;
CREATE INDEX IF NOT EXISTS ix_qf_insp_data      ON tab_qf_inspecao (data_inspecao DESC) WHERE NOT excluido;
CREATE INDEX IF NOT EXISTS ix_qf_insp_pc        ON tab_qf_inspecao (pedido_compras);
CREATE INDEX IF NOT EXISTS ix_qf_insp_nf        ON tab_qf_inspecao (nota_fiscal);
CREATE INDEX IF NOT EXISTS ix_qf_insp_item      ON tab_qf_inspecao ((LTRIM(cod_item, '0')), data_inspecao DESC);

-- ---------------------------------------------------------------- trilha de auditoria (append-only)
CREATE TABLE IF NOT EXISTS tab_qf_log (
  id              BIGSERIAL PRIMARY KEY,
  entidade        VARCHAR(20) NOT NULL,
  entidade_id     INTEGER,
  fornecedor_id   INTEGER,
  acao            VARCHAR(30) NOT NULL,
  campo           VARCHAR(60),
  valor_anterior  TEXT,
  valor_novo      TEXT,
  motivo          TEXT,
  usuario_id      INTEGER,
  usuario_nome    VARCHAR(120),
  ip              VARCHAR(60),
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_qf_log_ent  ON tab_qf_log (entidade, entidade_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS ix_qf_log_forn ON tab_qf_log (fornecedor_id, criado_em DESC);

CREATE OR REPLACE FUNCTION fn_qf_log_imutavel() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'tab_qf_log é somente inclusão (RDC 665/2022): registros não podem ser alterados nem apagados.';
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS tg_qf_log_imutavel ON tab_qf_log;
CREATE TRIGGER tg_qf_log_imutavel BEFORE UPDATE OR DELETE ON tab_qf_log
  FOR EACH ROW EXECUTE FUNCTION fn_qf_log_imutavel();

-- ---------------------------------------------------------------- notificações (idempotência)
CREATE TABLE IF NOT EXISTS tab_qf_notificacao (
  id             SERIAL PRIMARY KEY,
  chave          VARCHAR(160) NOT NULL UNIQUE,
  tipo           VARCHAR(30) NOT NULL,
  entidade       VARCHAR(20),
  entidade_id    INTEGER,
  fornecedor_id  INTEGER,
  destinatarios  TEXT,
  assunto        VARCHAR(250),
  enviado        BOOLEAN NOT NULL DEFAULT FALSE,
  erro           TEXT,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------- configuração
CREATE TABLE IF NOT EXISTS tab_qf_config (
  chave           VARCHAR(60) PRIMARY KEY,
  valor           JSONB,
  descricao       VARCHAR(250),
  atualizado_por  INTEGER,
  atualizado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO tab_qf_config (chave, valor, descricao) VALUES
  ('emails_qualidade',      '[]'::jsonb,  'Garantia da Qualidade: questionário recebido, inspeção reprovada, auditoria'),
  ('emails_engenharia',     '[]'::jsonb,  'Engenharia: bloqueios (inativar no ERP), plano de ação, documentos, requalificação, aprovação'),
  ('acoes_automaticas',     'true'::jsonb, 'Ações por classe (PRO 5.9 + decisão 30/10): C e D bloqueiam até o plano de ação; D exige 100%; E reprova e inativa'),
  ('suspender_doc_vencido', 'true'::jsonb, 'Suspender o fornecedor crítico com documento obrigatório vencido sem regularização (PRO 5.11)'),
  ('suspender_requalificacao_vencida', 'true'::jsonb, 'Suspender o fornecedor crítico cuja requalificação anual não foi concluída até o vencimento (PRO 5.10 Nota 3)'),
  ('email_fornecedor',      'false'::jsonb,'Enviar e-mail ao FORNECEDOR (externo). Desligado até a Qualidade validar os textos'),
  ('dias_alerta_documento', '[30, 1]'::jsonb, 'Antecedência (dias) dos avisos de vencimento de documento'),
  ('dias_alerta_requalificacao', '[60, 30]'::jsonb, 'Antecedência (dias) dos avisos de requalificação (PRO 5.10.1: iniciar com no mínimo 30 dias)'),
  ('questionario_validade_dias', '30'::jsonb, 'Validade do link dos formulários enviados ao fornecedor (FORM 7.3.21 / 7.3.28)')
ON CONFLICT (chave) DO NOTHING;

-- ---------------------------------------------------------------- matriz de documentos (FORM 7.3.21 REV OUT26 — PRO 5.3)
-- "aplicável para fornecedor nacional" → somente_nacional. "somente se aplicável" /
-- condição entre parênteses → CONDICIONAL (não bloqueia; a Engenharia avalia — Nota 2).
INSERT INTO tab_qf_tipo_documento (codigo, nome, regra_a, regra_b, regra_c, regra_d, somente_nacional, condicao, exige_validade, gerado_sistema, ordem) VALUES
  ('JUNTA_COMERCIAL',          'Certidão Junta Comercial do Estado (atualizada)',                       'OBRIGATORIO','OBRIGATORIO','OBRIGATORIO','OBRIGATORIO', TRUE,  NULL, TRUE,  FALSE, 10),
  ('INSCRICAO_MUNICIPAL',      'Inscrição Municipal',                                                   'OBRIGATORIO','OBRIGATORIO','OBRIGATORIO','OBRIGATORIO', TRUE,  NULL, FALSE, FALSE, 20),
  ('CONTRATO_SOCIAL',          'Contrato Social (última revisão)',                                      'OBRIGATORIO','OBRIGATORIO','OBRIGATORIO','OBRIGATORIO', TRUE,  NULL, FALSE, FALSE, 30),
  ('LICENCA_VISA',             'Licença de funcionamento Vigilância Sanitária',                         'CONDICIONAL','OBRIGATORIO','OBRIGATORIO','OBRIGATORIO', TRUE,  'Crítico A: somente se aplicável', TRUE, FALSE, 40),
  ('AFE_ANVISA',               'AFE – ANVISA',                                                          'CONDICIONAL','OBRIGATORIO','OBRIGATORIO', NULL,         TRUE,  'Crítico A: somente se aplicável', FALSE, FALSE, 50),
  ('REGISTRO_ANVISA',          'Registro ANVISA',                                                       NULL,         'OBRIGATORIO','OBRIGATORIO', NULL,         TRUE,  NULL, TRUE,  FALSE, 60),
  ('CERTIDAO_RT',              'Certidão RT em conselho de classe',                                     NULL,         'OBRIGATORIO','OBRIGATORIO', NULL,         TRUE,  NULL, TRUE,  FALSE, 70),
  ('CERTIDAO_ESTABELECIMENTO', 'Certidão do estabelecimento em conselho de classe',                     NULL,         'OBRIGATORIO','OBRIGATORIO', NULL,         TRUE,  NULL, TRUE,  FALSE, 80),
  ('CERT_RDC665',              'Certificação de Qualidade RDC 665',                                     NULL,         'CONDICIONAL','CONDICIONAL', NULL,         FALSE, 'produtos classe de risco III e IV', TRUE, FALSE, 90),
  ('CERT_ISO',                 'Certificação de Qualidade ISO 13485 ou ISO 9001',                       'OBRIGATORIO','CONDICIONAL','CONDICIONAL', NULL,         FALSE, 'Crítico B e C: ISO 13485, somente se aplicável', TRUE, FALSE, 100),
  ('CERT_INMETRO',             'Certificado INMETRO – Portaria 384:2020',                               NULL,         'OBRIGATORIO','OBRIGATORIO', NULL,         TRUE,  NULL, TRUE,  FALSE, 110),
  ('ACREDITACAO_17025',        'Acreditação ISO IEC 17025',                                             NULL,         NULL,         NULL,         'CONDICIONAL', FALSE, 'empresas que fornecem serviços de calibração de equipamento', TRUE, FALSE, 120),
  ('REFERENCIAS_MERCADO',      'Referências no mercado',                                                'OBRIGATORIO', NULL,         NULL,         NULL,         FALSE, NULL, FALSE, FALSE, 130),
  ('LICENCA_AMBIENTAL',        'Licenciamento Ambiental',                                               'CONDICIONAL', NULL,         NULL,         NULL,         TRUE,  'somente para serviços poluentes', TRUE, FALSE, 140),
  ('CAPACIDADE_TECNICA',       'Documentos comprobatórios de capacidade técnica e de credenciamento em órgão competente', 'CONDICIONAL', NULL, NULL, NULL, FALSE, 'somente para serviços de calibração, controle de pragas e processos especiais', TRUE, FALSE, 150),
  ('CURRICULO',                'Currículo profissional',                                                'CONDICIONAL', NULL,         NULL,         NULL,         FALSE, 'somente para consultores', FALSE, FALSE, 160),
  ('CERT_COMPONENTE',          'Certificação do componente',                                            'CONDICIONAL', NULL,         NULL,         NULL,         FALSE, 'somente se aplicável', TRUE, FALSE, 170),
  ('FORM_7321',                'FORM 7.3.21 - Cadastro e Avaliação de Fornecedores preenchido',         'OBRIGATORIO','OBRIGATORIO','OBRIGATORIO','OBRIGATORIO', FALSE, NULL, FALSE, TRUE,  180),
  ('ACORDO_QUALIDADE',         'Acordo de Qualidade (FORM 7.3.27)',                                     'OBRIGATORIO','OBRIGATORIO','OBRIGATORIO','OBRIGATORIO', FALSE, NULL, FALSE, FALSE, 190),
  ('OUTROS',                   'Outros',                                                                NULL,          NULL,         NULL,         NULL,         FALSE, NULL, FALSE, FALSE, 999)
ON CONFLICT (codigo) DO NOTHING;

-- ---------------------------------------------------------------- questionário oficial (FORM 7.3.21 REV OUT26)
-- Texto do formulário; só erros evidentes de digitação foram corrigidos. Editável na Configuração.
INSERT INTO tab_qf_pergunta (codigo, secao, texto, ajuda, ordem) VALUES
  ('1.1','1. GESTÃO DA QUALIDADE','A empresa possui Sistema de Gestão da Qualidade certificado pela norma ISO 13485:2016 / ISO 9001 ou RDC 665?','Fornecer uma cópia do certificado.',110),
  ('1.2','1. GESTÃO DA QUALIDADE','Você permitirá que a GNATUS acesse suas instalações, pessoal, documentos e informações relevantes para confirmar as informações prestadas neste questionário?','A GNATUS pode optar por realizar auditorias ou outras visitas às suas instalações com o objetivo de qualificação inicial ou para trabalhar com você nos esforços de melhoria do produto/processo/serviço.',120),
  ('2.1','2. GESTÃO AMBIENTAL','Existem controles para o manuseio e armazenamento de substâncias perigosas usadas durante o processo de fabricação dos produtos ou serviço?','Caso sim, fornecer as instruções de manuseio e armazenamento.',210),
  ('2.2','2. GESTÃO AMBIENTAL','Os materiais e produtos são armazenados de forma a preservar sua integridade?','Caso sim, fornecer as instruções de manuseio e armazenamento.',220),
  ('2.3','2. GESTÃO AMBIENTAL','A empresa faz uso de embalagens biodegradáveis?','Caso sim, informar quais embalagens e os materiais utilizados.',230),
  ('2.4','2. GESTÃO AMBIENTAL','A empresa faz coleta, separação e descarte seletivo dos resíduos de substâncias perigosas, como de metais pesados, que não podem ser colocados no lixo comum?','Caso sim, fornecer procedimento para separação e descarte dos resíduos perigosos.',240),
  ('2.5','2. GESTÃO AMBIENTAL','Os resíduos gerados durante o processo produtivo como plásticos, papéis, papelões são destinados aos locais de reciclagem?','Caso sim, fornecer procedimento de reciclagem.',250),
  ('2.6','2. GESTÃO AMBIENTAL','Existe um cronograma de limpeza das instalações?','Caso sim, fornecer procedimento de limpeza.',260),
  ('2.7','2. GESTÃO AMBIENTAL','Para transporte de produtos e mercadorias, a empresa dá preferência no uso de combustíveis renováveis ou na contratação de transportadoras que fazem uso de combustíveis renováveis?','Caso sim, informar o combustível utilizado.',270),
  ('2.8','2. GESTÃO AMBIENTAL','Durante os últimos cinco anos, você operou sem um acidente que resultou em lesão ou morte de um de seus funcionários?','Forneça o número de acidentes de cada tipo durante este período.',280),
  ('2.9','2. GESTÃO AMBIENTAL','Os recursos naturais são utilizados sem gerar desperdícios?','Caso sim, comente como faz para evitar o desperdício.',290),
  ('3.1','3. PROCESSO PRODUTIVO','Você usa controle de processo em sua operação?','Isso garante que pessoas e processos sejam qualificados e controlados, não conformidades sejam identificadas e ações preventivas e corretivas sejam tomadas. Forneça um exemplo de seu plano de controle padrão.',310),
  ('3.2','3. PROCESSO PRODUTIVO','Existem instruções ou procedimentos para os postos de fabricação?','As instruções e procedimentos são utilizados para garantir que o colaborador segue o escopo do que foi definido para realização de testes, etapas de montagem, entre outros. Fornecer algum exemplo de documento usado no processo.',320),
  ('3.3','3. PROCESSO PRODUTIVO','Você controla os parâmetros monitorados?','Caso sim, cite quais parâmetros são monitorados e como é feito o monitoramento. Exemplo: controle de temperatura, pressão, entre outros.',330),
  ('3.4','3. PROCESSO PRODUTIVO','Os dispositivos de testes, ensaios, medição e monitoramento são controlados, calibrados periodicamente?','Caso sim, como é feito o controle? Exemplo: os paquímetros devem ser calibrados anualmente e o controle é feito através de uma planilha de calibração.',340),
  ('3.5','3. PROCESSO PRODUTIVO','Há alguma etapa de conferência ou inspeção de matéria prima?','Caso sim, é feito algum registro desta inspeção? Quais os parâmetros utilizados para avaliação do produto?',350),
  ('3.6','3. PROCESSO PRODUTIVO','São realizadas inspeções / testes / verificações antes de liberar o produto ou serviço?','Caso sim, é feito algum registro desta inspeção? Quais os parâmetros utilizados para avaliação do produto ou serviço?',360),
  ('4.1','4. OPERACIONAL','Os materiais e produtos são identificados e rastreáveis por meio de seus processos até a GNATUS?','Você pode rastrear os materiais recebidos por lote ou número de peça na peça ou produto que é produzido?',410),
  ('4.2','4. OPERACIONAL','Existe controle para impedir a mistura de lotes ou materiais?','Caso sim, fornecer os procedimentos utilizados.',420),
  ('4.3','4. OPERACIONAL','São realizadas as manutenções preventivas das máquinas ou dispositivos utilizados na fabricação ou serviço?','Caso sim, fornecer os procedimentos utilizados.',430),
  ('4.4','4. OPERACIONAL','Você se compromete a não fazer alterações em produtos ou processos sem notificação prévia por escrito e/ou aprovação?','Isso também inclui quaisquer alterações no design da peça, materiais, subfornecedores ou local de fabricação.',440),
  ('4.5','4. OPERACIONAL','Você concorda em comunicar o progresso e atualizar os prazos/programações de entrega para seus clientes?','Inclui mudanças nos cronogramas, pedidos e entregas.',450),
  ('4.6','4. OPERACIONAL','Seu sistema logístico (recepção, estoques, armazéns, expedição, etc.) está adequado para atender as necessidades da GNATUS?','Caso sim, qual procedimento utilizado para estes? Em caso de atrasos, problemas na frota como é tratado e como a GNATUS será avisada?',460),
  ('4.7','4. OPERACIONAL','As aquisições são realizadas de fornecedores selecionados e monitorados?','Caso sim, como é feito o monitoramento e quais são os critérios avaliados?',470),
  ('4.8','4. OPERACIONAL','Existe um canal para atendimento de reclamações com o posterior retorno ao cliente?','Qual o canal utilizado e qual o prazo de atendimento?',480),
  ('4.9','4. OPERACIONAL','Você possui processos quarteirizados que impactam no produto/serviço da GNATUS?','Caso sim, citar os fornecedores e os itens que são fornecidos.',490),
  ('5.1','5. ANÁLISE DE NÃO CONFORMIDADES','Há procedimento para o controle, identificação e tratamento de produtos não-conformes?','Caso sim, fornecer os procedimentos utilizados.',510),
  ('5.2','5. ANÁLISE DE NÃO CONFORMIDADES','São tomadas medidas para ações corretivas e preventivas para as não conformidades encontradas?','Caso sim, fornecer os procedimentos utilizados.',520),
  ('5.3','5. ANÁLISE DE NÃO CONFORMIDADES','Os resultados das ações tomadas são monitorados e registrados?','Caso sim, fornecer os procedimentos utilizados.',530),
  ('5.4','5. ANÁLISE DE NÃO CONFORMIDADES','É utilizada alguma metodologia de investigação da não conformidade para descobrir a causa raiz?','Cite a metodologia utilizada.',540),
  ('6.1','6. SEGURANÇA DA INFORMAÇÃO (LGPD – Lei nº 13.709/2018)','A empresa realiza o tratamento dos dados (por exemplo a coleta) especificando e informando de forma clara e precisa ao titular (cliente, colaboradores, etc.) a finalidade e forma da coleta?','Fornecer como é feita a coleta de dados e qual a finalidade.',610),
  ('6.2','6. SEGURANÇA DA INFORMAÇÃO (LGPD – Lei nº 13.709/2018)','A empresa obtém consentimento do titular dos dados, salvo nos casos de tratamento de dados tornados públicos pelo próprio titular, sendo necessário, mesmo nestes casos, a adoção de medidas que visem a resguardar a segurança desses dados?','Fornecer o acordo que é feito sobre segurança e compartilhamento de dados.',620),
  ('6.3','6. SEGURANÇA DA INFORMAÇÃO (LGPD – Lei nº 13.709/2018)','A empresa não utiliza posteriormente os dados coletados para fins que não sejam os que foram previamente informados ao titular, o qual aceitou os termos na ocasião da coleta?','Fornecer o acordo que é feito sobre segurança e compartilhamento de dados.',630),
  ('6.4','6. SEGURANÇA DA INFORMAÇÃO (LGPD – Lei nº 13.709/2018)','A empresa possui sistemas de segurança aptos a proteger os dados coletados contra terceiros não autorizados, como por exemplo, instalar sistemas contra invasão de hackers?','Caso sim, qual sistema é utilizado? O sistema é validado? Utiliza mais de um sistema?',640),
  ('6.5','6. SEGURANÇA DA INFORMAÇÃO (LGPD – Lei nº 13.709/2018)','A empresa adota medidas para garantir a transparência do tratamento de dados baseado em seu legítimo interesse (somente dados necessários à empresa podem ser obtidos)?','Fornecer os fins dos dados que foram coletados.',650),
  ('6.6','6. SEGURANÇA DA INFORMAÇÃO (LGPD – Lei nº 13.709/2018)','A empresa adota medidas para prevenir a ocorrência de danos em virtude do tratamento dos dados, como por exemplo, orientar e treinar os funcionários e os contratados a respeito das práticas a serem tomadas em relação à proteção de dados pessoais?','Fornecer as medidas de prevenção e o treinamento realizado com os colaboradores.',660)
ON CONFLICT (codigo) DO NOTHING;

-- ---------------------------------------------------------------- versões de regra
-- 1) Planilha FORM 7.4.3.H REV OUT25 — só para o histórico importado (P digitado pelos
--    inspetores: D-1 1,1 / D+1 1,0 / D+3 0,9 / D+5 0,8 / D+7 0,7).
INSERT INTO tab_qf_regra_versao (nome, referencia, descricao, conteudo, ativa)
SELECT 'FORM 7.4.3.H REV OUT25 (planilha — histórico)', 'FORM 7.4.3.H — aba NOTAS FORNECEDOR, REV OUT25',
       'Tabelas que os inspetores usavam na planilha até a implantação. Mantida só para rastrear o histórico importado (C, P e N foram digitados e não são recalculados).',
       $h${
  "pontos": {"SIM": 2, "PARCIAL": 1, "NAO": 0},
  "questionario": {"aprovado_min": 70, "restricao_min": 50},
  "faixasC": [
    {"min": 100, "valor": 10, "rotulo": "100% conforme"},
    {"min": 80, "valor": 8, "rotulo": "80% a 99,9% conforme"},
    {"min": 70, "valor": 5, "rotulo": "70% a 79,9% conforme"},
    {"min": 60, "valor": 3, "rotulo": "60% a 69,9% conforme"},
    {"min": 0, "valor": 0, "rotulo": "até 59,9% conforme"}
  ],
  "faixasP": [
    {"ate": -1, "valor": 1.1, "rotulo": "Prazo D-1 (antecipada)"},
    {"ate": 1, "valor": 1.0, "rotulo": "Prazo até D+1"},
    {"ate": 3, "valor": 0.9, "rotulo": "Prazo D+2 a D+3"},
    {"ate": 5, "valor": 0.8, "rotulo": "Prazo D+4 a D+5"},
    {"ate": null, "valor": 0.7, "rotulo": "Prazo D+6 em diante (D+7)"}
  ],
  "faixasN": [
    {"ncs": 0, "valor": 1.0, "rotulo": "0 NC nas últimas 3 entregas"},
    {"ncs": 1, "valor": 0.9, "rotulo": "1 NC nas últimas 3 entregas"},
    {"ncs": 2, "valor": 0.8, "rotulo": "2 NCs nas últimas 3 entregas"},
    {"ncs": 3, "valor": 0.7, "rotulo": "3 NCs ou mais nas últimas 3 entregas"}
  ],
  "janelaN": 3,
  "escopoN": "FORNECEDOR",
  "classes": [
    {"classe": "A", "min": 9, "rotulo": "APROVADO – ÓTIMO DESEMPENHO", "cor": "#13753a", "acao": "NENHUMA"},
    {"classe": "B", "min": 8, "rotulo": "APROVADO – BOM DESEMPENHO", "cor": "#55a83a", "acao": "NENHUMA"},
    {"classe": "C", "min": 7, "rotulo": "APROVADO – SOMENTE COM PLANO DE AÇÃO", "cor": "#efb300", "acao": "NENHUMA"},
    {"classe": "D", "min": 5, "rotulo": "APROVADO – PLANO DE AÇÃO + INSPEÇÃO 100% DO LOTE", "cor": "#9c1c8c", "acao": "NENHUMA"},
    {"classe": "E", "min": null, "rotulo": "REPROVADO", "cor": "#d84315", "acao": "NENHUMA"}
  ]
}$h$::jsonb, FALSE
WHERE NOT EXISTS (SELECT 1 FROM tab_qf_regra_versao WHERE nome = 'FORM 7.4.3.H REV OUT25 (planilha — histórico)');

-- 2) PRO 7.3.7 REV OUT261 (29/10/2026) — ATIVA.
--    P (5.9): nacional pela data prevista de ENTREGA, importado pela data prevista de
--    COLETA, antecipação (AD) para os dois. "N dias de atraso" = faixa até N dias.
--    Pontos que o PRO não define e foram completados (visíveis na tela de regras):
--      - importado com mais de 15 dias de atraso → 0,6 (último valor da tabela);
--      - a tabela de N não está no PRO OUT261: mantida a da planilha (0/1/2/3+ NC);
--      - N contado nas últimas 3 entregas do mesmo FORNECEDOR + ITEM (decisão 30/10).
--    Ações por classe (decisão 30/10): C e D bloqueiam o recebimento até a Engenharia
--    registrar o plano de ação (D volta só com inspeção 100%); E reprova e inativa.
INSERT INTO tab_qf_regra_versao (nome, referencia, descricao, conteudo, ativa, ativada_em)
SELECT 'PRO 7.3.7 REV OUT261', 'PRO 7.3.7 — Qualificação de Fornecedor, REV OUT261 (29/10/2026), item 5.9',
       'Tabela de P do procedimento vigente (nacional por entrega, importado por coleta, antecipação penalizada). N não consta no PRO OUT261 — mantida a tabela anterior. Importado acima de 15 dias de atraso não previsto — usado 0,6.',
       $j${
  "pontos": {"SIM": 2, "PARCIAL": 1, "NAO": 0},
  "questionario": {"aprovado_min": 70, "restricao_min": 50},
  "faixasC": [
    {"min": 100, "valor": 10, "rotulo": "100% conforme"},
    {"min": 80, "valor": 8, "rotulo": "80% a 99,9% conforme"},
    {"min": 70, "valor": 5, "rotulo": "70% a 79,9% conforme"},
    {"min": 60, "valor": 3, "rotulo": "60% a 69,9% conforme"},
    {"min": 0, "valor": 0, "rotulo": "até 59,9% conforme"}
  ],
  "prazo": {
    "nacional": [
      {"ate": 2, "valor": 1.0, "rotulo": "No prazo até 2 dias de atraso"},
      {"ate": 3, "valor": 0.95, "rotulo": "3 dias de atraso"},
      {"ate": 5, "valor": 0.9, "rotulo": "4 a 5 dias de atraso"},
      {"ate": 7, "valor": 0.85, "rotulo": "6 a 7 dias de atraso"},
      {"ate": 10, "valor": 0.8, "rotulo": "8 a 10 dias de atraso"},
      {"ate": 15, "valor": 0.7, "rotulo": "11 a 15 dias de atraso"},
      {"ate": null, "valor": 0.6, "rotulo": "Mais de 15 dias de atraso"}
    ],
    "importado": [
      {"ate": 5, "valor": 1.0, "rotulo": "Coleta no prazo até 5 dias de atraso"},
      {"ate": 7, "valor": 0.9, "rotulo": "6 a 7 dias de atraso na coleta"},
      {"ate": 10, "valor": 0.8, "rotulo": "8 a 10 dias de atraso na coleta"},
      {"ate": 15, "valor": 0.6, "rotulo": "11 a 15 dias de atraso na coleta"},
      {"ate": null, "valor": 0.6, "rotulo": "Mais de 15 dias de atraso na coleta (não previsto no PRO — usado 0,6)"}
    ],
    "antecipacao": [
      {"ate": 2, "valor": 1.0, "rotulo": "Antecipação de 0 a 2 dias"},
      {"ate": 5, "valor": 0.9, "rotulo": "Antecipação de 3 a 5 dias"},
      {"ate": 10, "valor": 0.8, "rotulo": "Antecipação de 6 a 10 dias"},
      {"ate": 15, "valor": 0.7, "rotulo": "Antecipação de 11 a 15 dias"},
      {"ate": null, "valor": 0.5, "rotulo": "Antecipação de mais de 15 dias"}
    ]
  },
  "faixasN": [
    {"ncs": 0, "valor": 1.0, "rotulo": "0 NC nas últimas 3 entregas do item"},
    {"ncs": 1, "valor": 0.9, "rotulo": "1 NC nas últimas 3 entregas do item"},
    {"ncs": 2, "valor": 0.8, "rotulo": "2 NCs nas últimas 3 entregas do item"},
    {"ncs": 3, "valor": 0.7, "rotulo": "3 NCs ou mais nas últimas 3 entregas do item"}
  ],
  "janelaN": 3,
  "escopoN": "FORNECEDOR_ITEM",
  "classes": [
    {"classe": "A", "min": 9, "rotulo": "APROVADO – ÓTIMO DESEMPENHO", "cor": "#13753a", "acao": "NENHUMA"},
    {"classe": "B", "min": 8, "rotulo": "APROVADO – BOM DESEMPENHO", "cor": "#55a83a", "acao": "NENHUMA"},
    {"classe": "C", "min": 7, "rotulo": "APROVADO – SOMENTE COM PLANO DE AÇÃO", "cor": "#efb300", "acao": "BLOQUEAR_PLANO"},
    {"classe": "D", "min": 5, "rotulo": "APROVADO – SOMENTE COM PLANO DE AÇÃO E INSPEÇÃO DE 100% DO LOTE RECEBIDO", "cor": "#9c1c8c", "acao": "BLOQUEAR_PLANO_100"},
    {"classe": "E", "min": null, "rotulo": "REPROVADO", "cor": "#d84315", "acao": "REPROVAR"}
  ],
  "requalificacao": {"meses": 12, "antecedenciaDias": 30},
  "auditoriaAcompanhamento": {"iqfLimite": 7, "avaliacoesConsecutivas": 2, "ncsMinimo": 3, "ncsJanelaMeses": 6},
  "amostragem": {
    "norma": "NBR 5426/1985 — plano de amostragem simples normal, NQA 2,5%",
    "I": [
      {"de": 2, "ate": 8, "amostra": 2, "ac": 0, "re": 1},
      {"de": 9, "ate": 15, "amostra": 2, "ac": 0, "re": 1},
      {"de": 16, "ate": 25, "amostra": 3, "ac": 0, "re": 1},
      {"de": 26, "ate": 50, "amostra": 5, "ac": 0, "re": 1},
      {"de": 51, "ate": 90, "amostra": 5, "ac": 0, "re": 1},
      {"de": 91, "ate": 150, "amostra": 8, "ac": 0, "re": 1},
      {"de": 151, "ate": 280, "amostra": 13, "ac": 1, "re": 2},
      {"de": 281, "ate": 500, "amostra": 20, "ac": 0, "re": 1},
      {"de": 501, "ate": 1200, "amostra": 32, "ac": 2, "re": 3},
      {"de": 1201, "ate": 3200, "amostra": 50, "ac": 3, "re": 4},
      {"de": 3201, "ate": 50000, "amostra": 80, "ac": 5, "re": 6}
    ],
    "II": [
      {"de": 2, "ate": 8, "amostra": 2, "ac": 0, "re": 1},
      {"de": 9, "ate": 15, "amostra": 3, "ac": 0, "re": 1},
      {"de": 16, "ate": 25, "amostra": 5, "ac": 0, "re": 1},
      {"de": 26, "ate": 50, "amostra": 8, "ac": 0, "re": 1},
      {"de": 51, "ate": 90, "amostra": 13, "ac": 1, "re": 2},
      {"de": 91, "ate": 150, "amostra": 20, "ac": 1, "re": 2},
      {"de": 151, "ate": 280, "amostra": 32, "ac": 2, "re": 3},
      {"de": 281, "ate": 500, "amostra": 50, "ac": 3, "re": 4},
      {"de": 501, "ate": 1200, "amostra": 80, "ac": 5, "re": 6},
      {"de": 1201, "ate": 3200, "amostra": 125, "ac": 7, "re": 8},
      {"de": 3201, "ate": 50000, "amostra": 200, "ac": 10, "re": 11}
    ]
  }
}$j$::jsonb, TRUE, NOW()
WHERE NOT EXISTS (SELECT 1 FROM tab_qf_regra_versao WHERE nome = 'PRO 7.3.7 REV OUT261');

-- ---------------------------------------------------------------- permissões (módulo Qualidade)
-- Hierárquicas: cada nível faz tudo o que o anterior faz. Papéis do PRO 7.3.7 item 4:
-- a Engenharia conduz a qualificação, requalificação e monitoramento; a Garantia da
-- Qualidade avalia o questionário e realiza auditorias.
INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo) VALUES
  (23001, 'Qualificação de Fornecedores - Consulta (lista, IQF, inspeções, dashboard)', 'Qualidade'),
  (23002, 'Qualificação de Fornecedores - Inspetor (lança inspeção de recebimento)', 'Qualidade'),
  (23003, 'Qualificação de Fornecedores - Engenharia (qualificação, requalificação, documentos, amostras, plano de ação)', 'Qualidade'),
  (23004, 'Qualificação de Fornecedores - Qualidade (análise do questionário, auditorias)', 'Qualidade'),
  (23005, 'Qualificação de Fornecedores - Gerente de Engenharia (aprova FORM 7.3.21 e 7.3.28)', 'Qualidade'),
  (23006, 'Qualificação de Fornecedores - Administração (regras, catálogos, importação)', 'Qualidade')
ON CONFLICT (id_permissao) DO NOTHING;

-- ---------------------------------------------------------------- GRANTs (migration roda como postgres)
GRANT SELECT, INSERT, UPDATE, DELETE ON
  tab_qf_regra_versao, tab_qf_item_critico, tab_qf_fornecedor, tab_qf_anexo, tab_qf_tipo_documento, tab_qf_documento,
  tab_qf_qualificacao, tab_qf_pergunta, tab_qf_ficha, tab_qf_resposta, tab_qf_auditoria,
  tab_qf_amostra, tab_qf_avaliacao, tab_qf_avaliacao_item, tab_qf_inspecao,
  tab_qf_notificacao, tab_qf_config TO intranet;
GRANT SELECT, INSERT ON tab_qf_log TO intranet;
GRANT USAGE, SELECT ON SEQUENCE
  tab_qf_regra_versao_id_seq, tab_qf_item_critico_id_seq, tab_qf_fornecedor_id_seq, tab_qf_anexo_id_seq,
  tab_qf_tipo_documento_id_seq, tab_qf_documento_id_seq, tab_qf_qualificacao_id_seq, tab_qf_pergunta_id_seq,
  tab_qf_ficha_id_seq, tab_qf_resposta_id_seq, tab_qf_auditoria_id_seq, tab_qf_amostra_id_seq, tab_qf_avaliacao_id_seq,
  tab_qf_avaliacao_item_id_seq, tab_qf_inspecao_id_seq, tab_qf_log_id_seq, tab_qf_notificacao_id_seq TO intranet;
