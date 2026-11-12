-- 151 — Universidade: avaliação com banco de questões, reprovações, responsável/ministrante,
--        treinamento interno × externo, certificados e painel do gestor.
--
-- Pedido do RH/Educacional (11/2026):
--   * avaliação com banco de questões (ex.: 20) e sorteio por tentativa (ex.: 10), com as
--     alternativas embaralhadas — cada tentativa guarda o que foi sorteado (correção e revisão
--     usam só isso; o aluno nunca recebe o banco inteiro);
--   * responsável pelo treinamento e ministrante; treinamento interno ou externo (externo =
--     ministrante + empresa);
--   * categoria "Normativo" no catálogo;
--   * certificado emitido fica registrado (código único, p/ conferência);
--   * gestor do setor = responsável do departamento no Protheus (SQB010.QB_MATRESP/QB_MATRSP2),
--     com a hierarquia QB_DEPSUP (gestor do setor de cima vê os de baixo).
--
-- Só ADD COLUMN / tabela nova / view nova. Idempotente. Aplicar como postgres (GRANTs no fim).

-- ---------------------------------------------------------------- catálogo
INSERT INTO tab_uni_categoria (nome, descricao, cor, ordem)
VALUES ('Normativo', 'Normas, procedimentos e requisitos regulatórios (ISO 13485, RDC, POPs, ITs)', '#8e3b9c', 6)
ON CONFLICT (nome) DO NOTHING;

-- ---------------------------------------------------------------- curso: responsável, ministrante, interno/externo
ALTER TABLE tab_uni_curso
  ADD COLUMN IF NOT EXISTS responsavel_colaborador_id INTEGER REFERENCES tab_uni_colaborador(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS responsavel_nome           VARCHAR(160),
  ADD COLUMN IF NOT EXISTS ministrante                VARCHAR(160),
  ADD COLUMN IF NOT EXISTS tipo_treinamento           VARCHAR(10) NOT NULL DEFAULT 'interno',
  ADD COLUMN IF NOT EXISTS empresa_externa            VARCHAR(160);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_uni_curso_tipo_trein') THEN
    ALTER TABLE tab_uni_curso ADD CONSTRAINT chk_uni_curso_tipo_trein CHECK (tipo_treinamento IN ('interno','externo'));
  END IF;
END $$;
COMMENT ON COLUMN tab_uni_curso.descricao IS 'Conteúdo programático — obrigatório; vai no verso do certificado.';

-- ---------------------------------------------------------------- lançamento: interno/externo + empresa
-- (o ministrante do lançamento é o campo instrutor que já existe)
ALTER TABLE tab_uni_registro_lote
  ADD COLUMN IF NOT EXISTS tipo_treinamento VARCHAR(10),
  ADD COLUMN IF NOT EXISTS empresa          VARCHAR(160);
ALTER TABLE tab_uni_registro
  ADD COLUMN IF NOT EXISTS tipo_treinamento VARCHAR(10),
  ADD COLUMN IF NOT EXISTS empresa          VARCHAR(160);

-- ---------------------------------------------------------------- avaliação: banco de questões + sorteio
ALTER TABLE tab_uni_quiz
  ADD COLUMN IF NOT EXISTS qtd_sorteio             SMALLINT,               -- NULL = todas as questões
  ADD COLUMN IF NOT EXISTS embaralhar_alternativas BOOLEAN NOT NULL DEFAULT FALSE;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_uni_quiz_sorteio') THEN
    ALTER TABLE tab_uni_quiz ADD CONSTRAINT chk_uni_quiz_sorteio CHECK (qtd_sorteio IS NULL OR qtd_sorteio > 0);
  END IF;
END $$;
-- [{ "q": <questao_id>, "a": [<alternativa_id>, ...] }, ...] na ordem em que o aluno viu.
-- NULL = tentativa antiga (todas as questões, ordem original).
ALTER TABLE tab_uni_tentativa ADD COLUMN IF NOT EXISTS questoes JSONB;

-- ---------------------------------------------------------------- setor: responsável (gestor) e setor superior
ALTER TABLE tab_uni_departamento
  ADD COLUMN IF NOT EXISTS depto_sup       VARCHAR(12),
  ADD COLUMN IF NOT EXISTS resp_filial     VARCHAR(4),
  ADD COLUMN IF NOT EXISTS resp_matricula  VARCHAR(10),
  ADD COLUMN IF NOT EXISTS resp_cpf        VARCHAR(14),
  ADD COLUMN IF NOT EXISTS resp2_filial    VARCHAR(4),
  ADD COLUMN IF NOT EXISTS resp2_matricula VARCHAR(10),
  ADD COLUMN IF NOT EXISTS resp2_cpf       VARCHAR(14);
CREATE INDEX IF NOT EXISTS ix_uni_depto_resp  ON tab_uni_departamento (resp_cpf);
CREATE INDEX IF NOT EXISTS ix_uni_depto_resp2 ON tab_uni_departamento (resp2_cpf);

-- ---------------------------------------------------------------- certificados emitidos
CREATE TABLE IF NOT EXISTS tab_uni_certificado (
  id              SERIAL PRIMARY KEY,
  codigo          VARCHAR(30)  NOT NULL UNIQUE,         -- GNT-AAAA-NNNNNN
  evidencia_ref   VARCHAR(40)  NOT NULL UNIQUE,         -- registro:N | inscricao:N | matricula:N
  colaborador_id  INTEGER NOT NULL REFERENCES tab_uni_colaborador(id) ON DELETE RESTRICT,
  curso_id        INTEGER NOT NULL REFERENCES tab_uni_curso(id) ON DELETE RESTRICT,
  versao_id       INTEGER REFERENCES tab_uni_curso_versao(id) ON DELETE SET NULL,
  data_conclusao  DATE NOT NULL,
  valido_ate      DATE,
  carga_h         NUMERIC(5,1),
  modalidade      VARCHAR(12),
  ministrante     VARCHAR(160),
  empresa         VARCHAR(160),
  emitido_por     INTEGER,
  emitido_em      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ultima_emissao  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  vezes_emitido   INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS ix_uni_cert_colab ON tab_uni_certificado (colaborador_id);

-- ---------------------------------------------------------------- reprovações (view)
-- Prova reprovada (tentativa finalizada não aprovada) + lançamento com resultado reprovado.
CREATE OR REPLACE VIEW vw_uni_reprovacao AS
SELECT 'tentativa:' || t.id AS ref, 'prova'::text AS fonte, col.id AS colaborador_id, m.curso_id,
       t.finalizada_em::date AS data, t.nota, q.nota_minima, NULL::int AS lote_id
  FROM tab_uni_tentativa t
  JOIN tab_uni_matricula m     ON m.id = t.matricula_id
  JOIN tab_uni_quiz q          ON q.id = t.quiz_id
  JOIN tab_uni_colaborador col ON col.user_id = m.user_id
 WHERE t.finalizada_em IS NOT NULL AND t.aprovado IS FALSE
UNION ALL
SELECT 'registro:' || r.id, 'lancamento', r.colaborador_id, r.curso_id, r.data_realizacao, r.nota, NULL::numeric, r.lote_id
  FROM tab_uni_registro r
 WHERE NOT r.anulado AND r.resultado = 'reprovado';

-- ---------------------------------------------------------------- GRANTs (migration roda como postgres)
GRANT SELECT, INSERT, UPDATE ON tab_uni_certificado TO intranet;
GRANT USAGE, SELECT ON SEQUENCE tab_uni_certificado_id_seq TO intranet;
GRANT SELECT ON vw_uni_reprovacao TO intranet;
