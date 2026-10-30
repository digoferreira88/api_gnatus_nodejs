-- 140 — Universidade: trilhas por cargo, versões de curso e registro de treinamento
--
-- Origem: não conformidade de auditoria (ISO 13485 §6.2) — colaborador exercendo a
-- função sem o treinamento exigido. Une a Universidade (EAD, tab_uni_*) e o
-- Treinamentos (turmas presenciais/online, tab_treina_*) numa só visão de competência:
--
--   cargo (Protheus SQ3) ──► trilhas ──► cursos obrigatórios (com prazo)
--   colaborador (Protheus SRA010, chave = CPF) ──► requisitos (1 por curso exigido)
--   evidência = registro manual/lote/legado  +  EAD concluído  +  presença em turma
--
-- Padrão de códigos do Educacional ("Padronização de cursos e treinamentos", out/2025):
--   [Formação]-[Área].[Formato]-R[AA][RR]-C[NN]   ex. FRL-PRD.P-R2600-C03
--
-- NADA é apagado: só tabelas novas e colunas novas nas tabelas existentes.
-- Registro de treinamento e versão publicada são imutáveis (trigger); registro errado
-- é ANULADO com motivo, nunca excluído.
--
-- Aplicar como postgres (GRANTs no fim). Idempotente.

-- ---------------------------------------------------------------- permissões
INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo) VALUES
  (15004, 'Universidade - RH (trilhas por cargo, cursos, versões e registros de treinamento)', 'Universidade'),
  (15005, 'Universidade - Conformidade de treinamentos (consulta)', 'Universidade')
ON CONFLICT (id_permissao) DO NOTHING;

-- ---------------------------------------------------------------- grandes áreas
CREATE TABLE IF NOT EXISTS tab_uni_area (
  id         SERIAL PRIMARY KEY,
  codigo     VARCHAR(6)   NOT NULL UNIQUE,
  nome       VARCHAR(120) NOT NULL,
  ativo      BOOLEAN      NOT NULL DEFAULT TRUE,
  criado_em  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
INSERT INTO tab_uni_area (codigo, nome) VALUES
  ('PRD', 'Produtos do Portfólio Gnatus'),
  ('MKT', 'Marketing'),
  ('ATC', 'Assistência Técnica Consultórios'),
  ('ATP', 'Assistência Técnica Periféricos'),
  ('PPY', 'Assistência Técnica linha Papaya'),
  ('PLT', 'Plataformas'),
  ('RHU', 'Recursos Humanos'),
  ('OPR', 'Operações'),
  ('QUA', 'Qualidade e Regulatório'),
  ('SST', 'Saúde e Segurança do Trabalho')
ON CONFLICT (codigo) DO NOTHING;

-- ---------------------------------------------------------------- curso: campos de catálogo
-- codigo passa de 20 p/ 40 (o código completo do padrão tem 19+ caracteres).
ALTER TABLE tab_uni_curso ALTER COLUMN codigo TYPE VARCHAR(40);
ALTER TABLE tab_uni_curso
  ADD COLUMN IF NOT EXISTS area_id           INTEGER REFERENCES tab_uni_area(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS formato           VARCHAR(1),     -- P presencial · E EAD · H híbrido
  ADD COLUMN IF NOT EXISTS validade_meses    SMALLINT,       -- NULL = não vence
  ADD COLUMN IF NOT EXISTS setor_responsavel VARCHAR(120),
  ADD COLUMN IF NOT EXISTS versao_atual_id   INTEGER;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_uni_curso_formato') THEN
    ALTER TABLE tab_uni_curso ADD CONSTRAINT chk_uni_curso_formato CHECK (formato IS NULL OR formato IN ('P','E','H'));
  END IF;
END $$;

-- ---------------------------------------------------------------- versões do curso
-- Revisão no padrão R[AA][RR] (R2600, R2601...). tipo 'adendo' = só a parte que mudou
-- (o ".Atual" do padrão). exige_retreinamento: quem fez versão anterior fica
-- DESATUALIZADO até fazer esta (ou uma posterior).
CREATE TABLE IF NOT EXISTS tab_uni_curso_versao (
  id                  SERIAL PRIMARY KEY,
  curso_id            INTEGER NOT NULL REFERENCES tab_uni_curso(id) ON DELETE CASCADE,
  revisao             VARCHAR(12) NOT NULL,
  tipo                VARCHAR(10) NOT NULL DEFAULT 'completa',
  status              VARCHAR(10) NOT NULL DEFAULT 'rascunho',
  vigente_desde       DATE,
  exige_retreinamento BOOLEAN NOT NULL DEFAULT FALSE,
  resumo_mudanca      TEXT,
  -- plano de ensino (documento interno, não vai para o aluno)
  objetivos           TEXT,
  conteudo            TEXT,
  materiais           TEXT,
  observacoes         TEXT,
  duracao_min         INTEGER,
  capacidade          INTEGER,
  professores         TEXT,
  documento_url       TEXT,
  publicado_por       INTEGER,
  publicado_em        TIMESTAMPTZ,
  criado_por          INTEGER,
  criado_em           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_uni_versao_tipo   CHECK (tipo IN ('completa','adendo')),
  CONSTRAINT chk_uni_versao_status CHECK (status IN ('rascunho','vigente','obsoleta')),
  CONSTRAINT ux_uni_versao_revisao UNIQUE (curso_id, revisao)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_uni_versao_vigente ON tab_uni_curso_versao (curso_id) WHERE status = 'vigente';

-- Versão publicada não muda de conteúdo (controle de documento). Só pode virar obsoleta.
CREATE OR REPLACE FUNCTION fn_uni_versao_imutavel() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'rascunho' THEN
      RAISE EXCEPTION 'Versão % publicada não pode ser excluída', OLD.revisao;
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'rascunho' AND (
       NEW.revisao IS DISTINCT FROM OLD.revisao OR NEW.tipo IS DISTINCT FROM OLD.tipo
    OR NEW.exige_retreinamento IS DISTINCT FROM OLD.exige_retreinamento
    OR NEW.vigente_desde IS DISTINCT FROM OLD.vigente_desde
    OR NEW.objetivos IS DISTINCT FROM OLD.objetivos OR NEW.conteudo IS DISTINCT FROM OLD.conteudo
    OR NEW.materiais IS DISTINCT FROM OLD.materiais OR NEW.resumo_mudanca IS DISTINCT FROM OLD.resumo_mudanca
    OR NEW.curso_id IS DISTINCT FROM OLD.curso_id
    OR (NEW.status = 'rascunho')) THEN
    RAISE EXCEPTION 'Versão % já publicada: crie uma nova revisão em vez de alterar', OLD.revisao;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS tg_uni_versao_imutavel ON tab_uni_curso_versao;
CREATE TRIGGER tg_uni_versao_imutavel BEFORE UPDATE OR DELETE ON tab_uni_curso_versao
  FOR EACH ROW EXECUTE FUNCTION fn_uni_versao_imutavel();

-- Versão inicial para os cursos que já existem (vigente desde a criação do curso).
INSERT INTO tab_uni_curso_versao (curso_id, revisao, tipo, status, vigente_desde, resumo_mudanca, publicado_em)
SELECT c.id, 'R' || to_char(c.criado_em, 'YY') || '00', 'completa', 'vigente', c.criado_em::date,
       'Versão inicial (registrada na unificação Universidade × Treinamentos)', NOW()
  FROM tab_uni_curso c
 WHERE NOT EXISTS (SELECT 1 FROM tab_uni_curso_versao v WHERE v.curso_id = c.id);
UPDATE tab_uni_curso c SET versao_atual_id = v.id
  FROM tab_uni_curso_versao v
 WHERE v.curso_id = c.id AND v.status = 'vigente' AND c.versao_atual_id IS NULL;

-- ---------------------------------------------------------------- trilhas (as "Formações")
CREATE TABLE IF NOT EXISTS tab_uni_trilha (
  id            SERIAL PRIMARY KEY,
  codigo        VARCHAR(12)  NOT NULL UNIQUE,
  nome          VARCHAR(160) NOT NULL,
  descricao     TEXT,
  publico       VARCHAR(10)  NOT NULL DEFAULT 'interno',
  aplica_todos  BOOLEAN      NOT NULL DEFAULT FALSE,   -- ex.: Integração — vale p/ todo colaborador
  ativo         BOOLEAN      NOT NULL DEFAULT TRUE,
  criado_por    INTEGER,
  criado_em     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_uni_trilha_publico CHECK (publico IN ('interno','externo'))
);

CREATE TABLE IF NOT EXISTS tab_uni_trilha_item (
  id              SERIAL PRIMARY KEY,
  trilha_id       INTEGER NOT NULL REFERENCES tab_uni_trilha(id) ON DELETE CASCADE,
  curso_id        INTEGER NOT NULL REFERENCES tab_uni_curso(id) ON DELETE RESTRICT,
  ordem           SMALLINT NOT NULL DEFAULT 0,
  obrigatorio     BOOLEAN  NOT NULL DEFAULT TRUE,
  prazo_dias      SMALLINT,                 -- dias a partir da entrada no cargo; NULL = sem prazo
  codigo_exibicao VARCHAR(40),              -- código do curso NESTA formação (equivalência)
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ux_uni_trilha_item UNIQUE (trilha_id, curso_id)
);
CREATE INDEX IF NOT EXISTS ix_uni_trilha_item_curso ON tab_uni_trilha_item (curso_id);

-- ---------------------------------------------------------------- cargos (espelho SQ3010)
CREATE TABLE IF NOT EXISTS tab_uni_cargo (
  codigo          VARCHAR(10) PRIMARY KEY,
  descricao       VARCHAR(120),
  ativo           BOOLEAN NOT NULL DEFAULT TRUE,
  sincronizado_em TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS tab_uni_cargo_trilha (
  cargo_codigo VARCHAR(10) NOT NULL REFERENCES tab_uni_cargo(codigo) ON DELETE CASCADE,
  trilha_id    INTEGER     NOT NULL REFERENCES tab_uni_trilha(id) ON DELETE CASCADE,
  criado_por   INTEGER,
  criado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (cargo_codigo, trilha_id)
);

-- ---------------------------------------------------------------- colaboradores (espelho SRA010)
-- Chave = CPF (segue a pessoa se trocar de filial/matrícula). Sem CPF: 'F<filial>-<mat>'.
CREATE TABLE IF NOT EXISTS tab_uni_colaborador (
  id              SERIAL PRIMARY KEY,
  chave           VARCHAR(20)  NOT NULL UNIQUE,
  cpf             VARCHAR(14),
  filial          VARCHAR(4),
  matricula       VARCHAR(10),
  nome            VARCHAR(120) NOT NULL,
  email           VARCHAR(150),
  cargo_codigo    VARCHAR(10),
  cargo_desc      VARCHAR(120),
  funcao_codigo   VARCHAR(10),
  funcao_desc     VARCHAR(120),
  depto_codigo    VARCHAR(12),
  depto_desc      VARCHAR(120),
  centro_custo    VARCHAR(20),
  admissao        DATE,
  demissao        DATE,
  situacao        VARCHAR(2),
  ativo           BOOLEAN NOT NULL DEFAULT TRUE,
  cargo_desde     DATE,                     -- entrada no cargo atual (admissão ou mudança)
  user_id         INTEGER REFERENCES tab_intranet_usr(id) ON DELETE SET NULL,
  sincronizado_em TIMESTAMPTZ,
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_uni_colab_cargo ON tab_uni_colaborador (cargo_codigo) WHERE ativo;
CREATE INDEX IF NOT EXISTS ix_uni_colab_depto ON tab_uni_colaborador (depto_desc) WHERE ativo;
CREATE INDEX IF NOT EXISTS ix_uni_colab_email ON tab_uni_colaborador (lower(email));
CREATE INDEX IF NOT EXISTS ix_uni_colab_user  ON tab_uni_colaborador (user_id);

-- Admissão, mudança de cargo e desligamento detectados na sincronização.
CREATE TABLE IF NOT EXISTS tab_uni_colaborador_evento (
  id             SERIAL PRIMARY KEY,
  colaborador_id INTEGER NOT NULL REFERENCES tab_uni_colaborador(id) ON DELETE CASCADE,
  tipo           VARCHAR(20) NOT NULL,
  de             TEXT,
  para           TEXT,
  data           DATE,
  registrado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_uni_evento_tipo CHECK (tipo IN ('carga_inicial','admissao','mudanca_cargo','desligamento','readmissao'))
);
CREATE INDEX IF NOT EXISTS ix_uni_evento_colab ON tab_uni_colaborador_evento (colaborador_id, registrado_em DESC);

CREATE TABLE IF NOT EXISTS tab_uni_sync_log (
  id           SERIAL PRIMARY KEY,
  iniciado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  concluido_em TIMESTAMPTZ,
  ok           BOOLEAN,
  origem       VARCHAR(20),               -- agendado | manual
  resumo       JSONB,
  erro         TEXT,
  executado_por INTEGER
);

-- ---------------------------------------------------------------- requisitos por pessoa
-- 1 linha por (colaborador, curso) exigido. Recalculado pela sincronização e a cada
-- mudança de trilha/cargo. Deixou de ser exigido = ativo false (histórico preservado).
CREATE TABLE IF NOT EXISTS tab_uni_requisito (
  id              SERIAL PRIMARY KEY,
  colaborador_id  INTEGER NOT NULL REFERENCES tab_uni_colaborador(id) ON DELETE CASCADE,
  curso_id        INTEGER NOT NULL REFERENCES tab_uni_curso(id) ON DELETE RESTRICT,
  obrigatorio     BOOLEAN NOT NULL DEFAULT TRUE,
  origem          TEXT,                     -- códigos das trilhas que exigem
  desde           DATE NOT NULL,            -- quando a exigência nasceu p/ esta pessoa
  prazo_dias      SMALLINT,
  ativo           BOOLEAN NOT NULL DEFAULT TRUE,
  inativado_em    TIMESTAMPTZ,
  dispensado      BOOLEAN NOT NULL DEFAULT FALSE,
  dispensa_motivo TEXT,
  dispensado_por  INTEGER,
  dispensado_em   TIMESTAMPTZ,
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ux_uni_requisito UNIQUE (colaborador_id, curso_id)
);
CREATE INDEX IF NOT EXISTS ix_uni_requisito_curso ON tab_uni_requisito (curso_id) WHERE ativo;

-- ---------------------------------------------------------------- registro de treinamento
-- Lote = um lançamento (turma presencial fora do sistema, leitura de procedimento,
-- histórico importado). A lista de presença assinada fica anexada ao lote.
CREATE TABLE IF NOT EXISTS tab_uni_registro_lote (
  id              SERIAL PRIMARY KEY,
  curso_id        INTEGER NOT NULL REFERENCES tab_uni_curso(id) ON DELETE RESTRICT,
  versao_id       INTEGER REFERENCES tab_uni_curso_versao(id) ON DELETE SET NULL,
  data_realizacao DATE NOT NULL,
  carga_h         NUMERIC(5,1),
  modalidade      VARCHAR(12),
  instrutor       VARCHAR(160),
  local           VARCHAR(160),
  verificacao     VARCHAR(12),
  observacao      TEXT,
  origem          VARCHAR(10) NOT NULL DEFAULT 'lote',
  anexo_path      TEXT,
  anexo_nome      TEXT,
  anexo_mime      VARCHAR(80),
  anexo_tamanho   INTEGER,
  criado_por      INTEGER,
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tab_uni_registro (
  id              SERIAL PRIMARY KEY,
  colaborador_id  INTEGER NOT NULL REFERENCES tab_uni_colaborador(id) ON DELETE RESTRICT,
  curso_id        INTEGER NOT NULL REFERENCES tab_uni_curso(id) ON DELETE RESTRICT,
  versao_id       INTEGER REFERENCES tab_uni_curso_versao(id) ON DELETE SET NULL,
  lote_id         INTEGER REFERENCES tab_uni_registro_lote(id) ON DELETE SET NULL,
  data_realizacao DATE NOT NULL,
  carga_h         NUMERIC(5,1),
  modalidade      VARCHAR(12),
  instrutor       VARCHAR(160),
  origem          VARCHAR(10) NOT NULL DEFAULT 'lote',
  verificacao     VARCHAR(12),
  nota            NUMERIC(5,2),
  resultado       VARCHAR(10) NOT NULL DEFAULT 'aprovado',
  observacao      TEXT,
  anulado         BOOLEAN NOT NULL DEFAULT FALSE,
  anulado_motivo  TEXT,
  anulado_por     INTEGER,
  anulado_em      TIMESTAMPTZ,
  registrado_por  INTEGER,
  registrado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_uni_reg_modal   CHECK (modalidade IS NULL OR modalidade IN ('presencial','online','ead','externo')),
  CONSTRAINT chk_uni_reg_origem  CHECK (origem IN ('manual','lote','legado')),
  CONSTRAINT chk_uni_reg_verif   CHECK (verificacao IS NULL OR verificacao IN ('avaliacao','observacao','na')),
  CONSTRAINT chk_uni_reg_result  CHECK (resultado IN ('aprovado','reprovado'))
);
CREATE INDEX IF NOT EXISTS ix_uni_registro_colab ON tab_uni_registro (colaborador_id, curso_id);
CREATE INDEX IF NOT EXISTS ix_uni_registro_lote  ON tab_uni_registro (lote_id);

-- Registro é evidência de competência: não se exclui, não se reescreve. Só se anula.
CREATE OR REPLACE FUNCTION fn_uni_registro_imutavel() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Registro de treinamento não pode ser excluído — anule com motivo';
  END IF;
  IF OLD.anulado THEN
    RAISE EXCEPTION 'Registro já anulado';
  END IF;
  IF NEW.colaborador_id IS DISTINCT FROM OLD.colaborador_id OR NEW.curso_id IS DISTINCT FROM OLD.curso_id
     OR NEW.versao_id IS DISTINCT FROM OLD.versao_id OR NEW.data_realizacao IS DISTINCT FROM OLD.data_realizacao
     OR NEW.resultado IS DISTINCT FROM OLD.resultado OR NEW.nota IS DISTINCT FROM OLD.nota
     OR NEW.origem IS DISTINCT FROM OLD.origem OR NEW.registrado_por IS DISTINCT FROM OLD.registrado_por
     OR NEW.registrado_em IS DISTINCT FROM OLD.registrado_em OR NOT NEW.anulado THEN
    RAISE EXCEPTION 'Registro de treinamento não pode ser alterado — anule e lance de novo';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS tg_uni_registro_imutavel ON tab_uni_registro;
CREATE TRIGGER tg_uni_registro_imutavel BEFORE UPDATE OR DELETE ON tab_uni_registro
  FOR EACH ROW EXECUTE FUNCTION fn_uni_registro_imutavel();

-- ---------------------------------------------------------------- turma (Treinamentos) → curso
-- Presença marcada numa turma vinculada vira evidência do curso (sem copiar dado).
ALTER TABLE tab_treina_treinamento
  ADD COLUMN IF NOT EXISTS curso_id        INTEGER REFERENCES tab_uni_curso(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS curso_versao_id INTEGER REFERENCES tab_uni_curso_versao(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ix_treina_curso ON tab_treina_treinamento (curso_id);

-- ---------------------------------------------------------------- evidências (view)
-- Todas as fontes num formato só. Não materializa: o dado continua no módulo de origem.
CREATE OR REPLACE VIEW vw_uni_evidencia AS
SELECT 'registro:' || r.id            AS ref,
       'registro'::text               AS fonte,
       r.colaborador_id, r.curso_id, r.versao_id,
       r.data_realizacao              AS data,
       r.modalidade, r.carga_h, r.instrutor, r.origem,
       (r.resultado = 'aprovado')     AS aprovado,
       r.nota, r.lote_id, r.id        AS registro_id,
       COALESCE(l.observacao, r.observacao) AS detalhe
  FROM tab_uni_registro r
  LEFT JOIN tab_uni_registro_lote l ON l.id = r.lote_id
 WHERE NOT r.anulado
UNION ALL
SELECT 'matricula:' || m.id, 'ead', col.id, m.curso_id, NULL::int,
       m.data_conclusao::date, 'ead', c.carga_horaria_h, c.instrutor_nome, 'ead',
       TRUE,
       (SELECT MAX(t.nota) FROM tab_uni_tentativa t WHERE t.matricula_id = m.id AND t.aprovado),
       NULL::int, NULL::int, 'Curso EAD concluído na Universidade'
  FROM tab_uni_matricula m
  JOIN tab_uni_curso c         ON c.id = m.curso_id
  JOIN tab_uni_colaborador col ON col.user_id = m.user_id
 WHERE m.status = 'concluido' AND m.data_conclusao IS NOT NULL
UNION ALL
SELECT 'inscricao:' || i.id, 'turma', col.id, t.curso_id, t.curso_versao_id,
       s.data, i.modalidade,
       CASE WHEN s.hora_inicio ~ '^\d{2}:\d{2}$' AND s.hora_fim ~ '^\d{2}:\d{2}$' AND s.hora_fim > s.hora_inicio
            THEN ROUND((EXTRACT(EPOCH FROM (s.hora_fim::time - s.hora_inicio::time)) / 3600)::numeric, 1) END,
       t.instrutor, 'turma', TRUE, NULL::numeric, NULL::int, NULL::int,
       'Presença na turma "' || t.titulo || '"'
  FROM tab_treina_inscricao i
  JOIN tab_treina_treinamento t ON t.id = i.treinamento_id
  JOIN tab_treina_sessao s      ON s.id = i.sessao_id
  JOIN tab_uni_colaborador col  ON col.id = (
         SELECT c2.id FROM tab_uni_colaborador c2
          WHERE (i.colaborador_id IS NOT NULL AND c2.user_id = i.colaborador_id)
             OR (i.colaborador_email IS NOT NULL AND lower(c2.email) = lower(i.colaborador_email))
          ORDER BY (c2.user_id = i.colaborador_id) DESC NULLS LAST, c2.ativo DESC
          LIMIT 1)
 WHERE t.curso_id IS NOT NULL AND i.status = 'ativa' AND i.presente;

-- ---------------------------------------------------------------- situação de cada requisito (view)
--   em_dia · a_vencer (vence em ≤ 60 dias) · pendente (no prazo) · atrasado (prazo passou)
--   vencido (validade passou) · desatualizado (versão nova exige retreinamento) · dispensado
CREATE OR REPLACE VIEW vw_uni_requisito_situacao AS
WITH vmin AS (
  SELECT DISTINCT ON (curso_id) curso_id, id AS versao_id, revisao, vigente_desde
    FROM tab_uni_curso_versao
   WHERE status IN ('vigente','obsoleta') AND exige_retreinamento AND vigente_desde IS NOT NULL
   ORDER BY curso_id, vigente_desde DESC, id DESC
), ev AS (
  SELECT DISTINCT ON (e.colaborador_id, e.curso_id)
         e.colaborador_id, e.curso_id, e.ref, e.fonte, e.data, e.versao_id,
         COALESCE(v.vigente_desde, e.data) AS data_versao, v.revisao
    FROM vw_uni_evidencia e
    LEFT JOIN tab_uni_curso_versao v ON v.id = e.versao_id
   WHERE e.aprovado AND e.data IS NOT NULL
   ORDER BY e.colaborador_id, e.curso_id, e.data DESC, e.ref
)
SELECT r.id, r.colaborador_id, r.curso_id, r.obrigatorio, r.origem, r.desde, r.prazo_dias,
       CASE WHEN r.prazo_dias IS NOT NULL THEN r.desde + r.prazo_dias END AS prazo,
       r.ativo, r.dispensado, r.dispensa_motivo, r.dispensado_em,
       ev.ref AS evidencia_ref, ev.fonte AS evidencia_fonte, ev.data AS evidencia_data,
       ev.revisao AS evidencia_revisao,
       vm.revisao AS revisao_minima,
       CASE WHEN ev.data IS NOT NULL AND c.validade_meses IS NOT NULL
            THEN (ev.data + make_interval(months => c.validade_meses))::date END AS valido_ate,
       CASE
         WHEN r.dispensado THEN 'dispensado'
         WHEN ev.ref IS NULL THEN
              CASE WHEN r.prazo_dias IS NOT NULL AND r.desde + r.prazo_dias < CURRENT_DATE THEN 'atrasado' ELSE 'pendente' END
         WHEN vm.versao_id IS NOT NULL AND ev.data_versao < vm.vigente_desde THEN 'desatualizado'
         WHEN c.validade_meses IS NOT NULL
              AND (ev.data + make_interval(months => c.validade_meses))::date < CURRENT_DATE THEN 'vencido'
         WHEN c.validade_meses IS NOT NULL
              AND (ev.data + make_interval(months => c.validade_meses))::date < CURRENT_DATE + 60 THEN 'a_vencer'
         ELSE 'em_dia'
       END AS situacao
  FROM tab_uni_requisito r
  JOIN tab_uni_curso c ON c.id = r.curso_id
  LEFT JOIN ev   ON ev.colaborador_id = r.colaborador_id AND ev.curso_id = r.curso_id
  LEFT JOIN vmin vm ON vm.curso_id = r.curso_id;

-- ---------------------------------------------------------------- GRANTs (migration roda como postgres)
GRANT SELECT, INSERT, UPDATE, DELETE ON
  tab_uni_area, tab_uni_curso_versao, tab_uni_trilha, tab_uni_trilha_item, tab_uni_cargo,
  tab_uni_cargo_trilha, tab_uni_colaborador, tab_uni_colaborador_evento, tab_uni_sync_log,
  tab_uni_requisito, tab_uni_registro_lote TO intranet;
GRANT SELECT, INSERT, UPDATE ON tab_uni_registro TO intranet;
GRANT SELECT ON vw_uni_evidencia, vw_uni_requisito_situacao TO intranet;
GRANT USAGE, SELECT ON SEQUENCE
  tab_uni_area_id_seq, tab_uni_curso_versao_id_seq, tab_uni_trilha_id_seq, tab_uni_trilha_item_id_seq,
  tab_uni_colaborador_id_seq, tab_uni_colaborador_evento_id_seq, tab_uni_sync_log_id_seq,
  tab_uni_requisito_id_seq, tab_uni_registro_lote_id_seq, tab_uni_registro_id_seq TO intranet;
