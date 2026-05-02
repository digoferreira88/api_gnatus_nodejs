-- ============================================================================
-- Universidade Gnatus - Fase 2: Quizzes/Avaliacoes
--
-- Modelo simples: 1 quiz final opcional por curso. Tipos de questao:
--   - multipla_escolha (1+ alternativas, so 1 correta)
--   - verdadeiro_falso (2 alternativas fixas: V/F)
-- (texto livre fica fora do MVP - exige correcao manual do instrutor)
--
-- Conclusao do curso passa a considerar o quiz:
--   - todas aulas obrigatorias OK + (quiz aprovado SE existir)
-- ============================================================================

-- ============== tab_uni_quiz ==============
CREATE TABLE IF NOT EXISTS tab_uni_quiz (
    id              SERIAL PRIMARY KEY,
    curso_id        int NOT NULL UNIQUE REFERENCES tab_uni_curso(id) ON DELETE CASCADE,
    titulo          varchar(200) NOT NULL,
    descricao       text,
    nota_minima     numeric(5,2) NOT NULL DEFAULT 70.00,  -- 0..100
    tentativas_max  smallint NOT NULL DEFAULT 3,           -- 0 = ilimitado
    embaralhar      boolean NOT NULL DEFAULT false,        -- embaralha questoes
    ativo           boolean NOT NULL DEFAULT true,
    criado_em       timestamp NOT NULL DEFAULT NOW(),
    atualizado_em   timestamp NOT NULL DEFAULT NOW()
);

-- ============== tab_uni_questao ==============
CREATE TABLE IF NOT EXISTS tab_uni_questao (
    id          SERIAL PRIMARY KEY,
    quiz_id     int NOT NULL REFERENCES tab_uni_quiz(id) ON DELETE CASCADE,
    ordem       smallint NOT NULL DEFAULT 0,
    enunciado   text NOT NULL,
    tipo        varchar(30) NOT NULL DEFAULT 'multipla_escolha', -- multipla_escolha|verdadeiro_falso
    pontuacao   numeric(5,2) NOT NULL DEFAULT 1.00,
    criado_em   timestamp NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_uni_questao_quiz ON tab_uni_questao (quiz_id, ordem);

-- ============== tab_uni_alternativa ==============
CREATE TABLE IF NOT EXISTS tab_uni_alternativa (
    id          SERIAL PRIMARY KEY,
    questao_id  int NOT NULL REFERENCES tab_uni_questao(id) ON DELETE CASCADE,
    ordem       smallint NOT NULL DEFAULT 0,
    texto       text NOT NULL,
    correta     boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS ix_uni_alt_questao ON tab_uni_alternativa (questao_id, ordem);

-- ============== tab_uni_tentativa ==============
-- Uma tentativa por (matricula, quiz). Quando aluno comeca, cria registro com finalizada_em NULL.
CREATE TABLE IF NOT EXISTS tab_uni_tentativa (
    id              SERIAL PRIMARY KEY,
    matricula_id    int NOT NULL REFERENCES tab_uni_matricula(id) ON DELETE CASCADE,
    quiz_id         int NOT NULL REFERENCES tab_uni_quiz(id) ON DELETE CASCADE,
    iniciada_em     timestamp NOT NULL DEFAULT NOW(),
    finalizada_em   timestamp,
    nota            numeric(5,2),                  -- 0..100 calculada apos finalizar
    aprovado        boolean
);
CREATE INDEX IF NOT EXISTS ix_uni_tent_matr ON tab_uni_tentativa (matricula_id, quiz_id);

-- ============== tab_uni_resposta ==============
-- Resposta do aluno em cada questao da tentativa.
CREATE TABLE IF NOT EXISTS tab_uni_resposta (
    id              SERIAL PRIMARY KEY,
    tentativa_id    int NOT NULL REFERENCES tab_uni_tentativa(id) ON DELETE CASCADE,
    questao_id      int NOT NULL REFERENCES tab_uni_questao(id) ON DELETE CASCADE,
    alternativa_id  int REFERENCES tab_uni_alternativa(id) ON DELETE SET NULL,
    correta         boolean NOT NULL DEFAULT false,
    pontos          numeric(5,2) NOT NULL DEFAULT 0,
    UNIQUE (tentativa_id, questao_id)
);
CREATE INDEX IF NOT EXISTS ix_uni_resp_tent ON tab_uni_resposta (tentativa_id);
