-- Painel de Gestão à Vista: configuração de pipes + setores (21/08/2026).
-- Idempotente.
--
-- 1) Quais pipes do Pipefy ENTRAM no painel (checklist na tela de config;
--    pipe sem linha aqui = considerado por padrão, então pipe novo aparece
--    sozinho e a TI desmarca se não quiser).
-- 2) Setores da empresa (seed fixo pedido pela TI) e o vínculo
--    responsável-do-Pipefy -> setor, base da visão "setores com maior
--    índice de atraso de atendimento".

CREATE TABLE IF NOT EXISTS tab_painel_setor (
  id    SERIAL PRIMARY KEY,
  nome  VARCHAR(60) NOT NULL UNIQUE,
  ordem INTEGER NOT NULL DEFAULT 0
);

INSERT INTO tab_painel_setor (nome, ordem) VALUES
  ('SAC', 1),
  ('COMERCIAL VAREJO', 2),
  ('COMERCIAL ATACADO', 3),
  ('ASSISTÊNCIA TÉCNICA', 4),
  ('SUPORTE TÉCNICO', 5),
  ('PRODUÇÃO', 6),
  ('CONTROLADORIA', 7),
  ('EXPEDIÇÃO', 8),
  ('PLANEJAMENTO', 9),
  ('FINANCEIRO', 10),
  ('JURÍDICO', 11),
  ('DIRETORIA', 12),
  ('FISCAL', 13)
ON CONFLICT (nome) DO NOTHING;

CREATE TABLE IF NOT EXISTS tab_painel_pipe (
  pipe_id        VARCHAR(20) PRIMARY KEY,
  nome           VARCHAR(120),
  considerar     BOOLEAN NOT NULL DEFAULT TRUE,
  atualizado_por VARCHAR(120),
  atualizado_em  TIMESTAMP NOT NULL DEFAULT NOW()
);

-- O pipe de teste da TI já nasce fora do painel
INSERT INTO tab_painel_pipe (pipe_id, nome, considerar)
VALUES ('306929743', 'Teste_TI', FALSE)
ON CONFLICT (pipe_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS tab_painel_usuario_setor (
  usuario_nome   VARCHAR(120) PRIMARY KEY,   -- nome do assignee como vem do Pipefy
  setor_id       INTEGER REFERENCES tab_painel_setor(id) ON DELETE SET NULL,
  atualizado_por VARCHAR(120),
  atualizado_em  TIMESTAMP NOT NULL DEFAULT NOW()
);
