-- Aplicar como postgres (GRANT no fim). Idempotente.
-- Gestão à Vista — espelho do Pipefy no banco (04/11/2026).
--
-- Antes, cada vez que o painel (TV, Visão Executiva ou Configuração) abria com o
-- cache de 5 min vencido, o backend varria o Pipefy inteiro: ~1 chamada por pipe
-- + 1 por página extra de 50 cards. Quanto mais gente olhava, mais o contrato
-- (10.000 chamadas/mês) sofria, e a tela esperava o Pipefy responder.
--
-- Agora o scheduler lê o Pipefy em horários fixos (job "painel-pipefy", padrão
-- de 3 em 3h das 06h às 18h, seg-sex) e grava aqui. As telas leem SÓ do banco:
-- abrir o painel, deixar a TV ligada ou clicar em "Atualizar" não gasta chamada.
--
-- tab_painel_pipefy_pipe  pipes da organização (todos, inclusive os que a config
--                         desmarcou — a tela de config lista daqui)
-- tab_painel_pipefy_card  cards ABERTOS dos pipes considerados (fase done fica fora)
-- tab_painel_pipefy_sync  uma linha por leitura: quando, quantas chamadas custou,
--                         quais pipes falharam
-- vw_painel_pipefy_card   cards com a situação já classificada (consulta/BI)

CREATE TABLE IF NOT EXISTS tab_painel_pipefy_pipe (
  pipe_id           VARCHAR(20) PRIMARY KEY,
  nome              VARCHAR(160),
  abertos_estimados INTEGER,                 -- soma de cards_count das fases abertas
  lido_em           TIMESTAMPTZ,             -- última vez que veio na lista da org
  cards_em          TIMESTAMPTZ,             -- última leitura BEM-SUCEDIDA dos cards
  erro              TEXT,                    -- falha da última tentativa (NULL = ok)
  erro_em           TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS tab_painel_pipefy_card (
  card_id        VARCHAR(20) PRIMARY KEY,
  pipe_id        VARCHAR(20) NOT NULL,
  titulo         TEXT,
  fase           VARCHAR(200),
  responsaveis   TEXT[]      NOT NULL DEFAULT '{}',   -- nomes dos assignees
  atrasado_fase  BOOLEAN     NOT NULL DEFAULT FALSE,  -- card.late: passou do SLA da fase
  vencido_pipe   BOOLEAN     NOT NULL DEFAULT FALSE,  -- card.expired: passou do vencimento do pipe
  vencimento     TIMESTAMPTZ,                         -- card.due_date
  criado_em      TIMESTAMPTZ,
  atualizado_em  TIMESTAMPTZ,                         -- updated_at no Pipefy
  na_fase_desde  TIMESTAMPTZ,                         -- lido_em - current_phase_age
  lido_em        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_painel_pipefy_card_pipe ON tab_painel_pipefy_card (pipe_id);

CREATE TABLE IF NOT EXISTS tab_painel_pipefy_sync (
  id             BIGSERIAL PRIMARY KEY,
  origem         VARCHAR(20) NOT NULL,       -- CRON | INICIAL | CONFIG
  completa       BOOLEAN     NOT NULL DEFAULT TRUE,   -- FALSE = só 1 pipe (config)
  inicio         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fim            TIMESTAMPTZ,
  requisicoes    INTEGER,                    -- chamadas gastas no Pipefy
  pipes          INTEGER,
  cards          INTEGER,
  pipes_com_erro TEXT[]      NOT NULL DEFAULT '{}',
  campos_ext     BOOLEAN,                    -- Pipefy aceitou updated_at/current_phase_age
  erro           TEXT                        -- falha geral (ex.: Pipefy fora do ar)
);
CREATE INDEX IF NOT EXISTS ix_painel_pipefy_sync_fim ON tab_painel_pipefy_sync (completa, id DESC);

-- Situação do card, mesma regra da Visão Executiva:
--   VENCIDO          passou do vencimento do pipe OU da data de vencimento do card
--   ATRASADO NA FASE passou do SLA da fase atual
--   NO PRAZO         nenhum dos dois
-- Dias = dias corridos inteiros até agora (iguais aos da tela).
CREATE OR REPLACE VIEW vw_painel_pipefy_card AS
SELECT c.card_id,
       c.pipe_id,
       p.nome AS pipe,
       c.titulo,
       c.fase,
       c.responsaveis,
       CASE WHEN c.vencido_pipe OR c.vencimento < NOW() THEN 'VENCIDO'
            WHEN c.atrasado_fase THEN 'ATRASADO NA FASE'
            ELSE 'NO PRAZO' END AS situacao,
       c.atrasado_fase,
       c.vencido_pipe,
       c.vencimento,
       CASE WHEN c.vencimento < NOW()
            THEN FLOOR(EXTRACT(EPOCH FROM NOW() - c.vencimento) / 86400)::int END AS dias_vencido,
       c.criado_em,
       FLOOR(EXTRACT(EPOCH FROM NOW() - c.criado_em) / 86400)::int     AS idade_dias,
       FLOOR(EXTRACT(EPOCH FROM NOW() - c.na_fase_desde) / 86400)::int AS dias_na_fase,
       FLOOR(EXTRACT(EPOCH FROM NOW() - c.atualizado_em) / 86400)::int AS dias_sem_movimento,
       'https://app.pipefy.com/open-cards/' || c.card_id AS link,
       c.lido_em
  FROM tab_painel_pipefy_card c
  LEFT JOIN tab_painel_pipefy_pipe p ON p.pipe_id = c.pipe_id;

GRANT SELECT, INSERT, UPDATE, DELETE ON tab_painel_pipefy_pipe, tab_painel_pipefy_card, tab_painel_pipefy_sync TO intranet;
GRANT USAGE, SELECT ON SEQUENCE tab_painel_pipefy_sync_id_seq TO intranet;
GRANT SELECT ON vw_painel_pipefy_card TO intranet;
