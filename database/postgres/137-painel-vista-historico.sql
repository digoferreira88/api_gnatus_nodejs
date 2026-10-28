-- Aplicar como postgres (GRANT no fim). Idempotente.
-- Painel de Gestão à Vista — histórico diário (Visão Executiva, 28/10/2026).
--
-- Foto do dia do que o painel já calcula, para a tela da diretoria mostrar
-- tendência ("o backlog está crescendo ou caindo?"). O Pipefy não guarda essa
-- série; sem esta tabela a tela só teria o retrato do momento.
--
-- Gravada pelo próprio snapshot (services/pipefyPainel.js) sempre que ele é
-- reconstruído — ou seja, só nos dias em que alguém abre o painel/TV. A última
-- leitura do dia vence (UPSERT). Não gera chamada extra ao Pipefy.
--
-- tipo  = 'total' (chave '*'), 'pipe' (chave = id do pipe), 'setor' (chave = nome)
-- O card conta 1x por setor distinto dos responsáveis (mesma regra do painel);
-- por isso a soma dos setores pode passar do total.

CREATE TABLE IF NOT EXISTS tab_painel_historico (
  dia           DATE        NOT NULL,
  tipo          VARCHAR(10) NOT NULL,
  chave         VARCHAR(80) NOT NULL,
  nome          VARCHAR(120),
  abertos       INTEGER     NOT NULL DEFAULT 0,
  atrasados     INTEGER     NOT NULL DEFAULT 0,
  mais_90d      INTEGER     NOT NULL DEFAULT 0,
  atualizado_em TIMESTAMP   NOT NULL DEFAULT NOW(),
  PRIMARY KEY (dia, tipo, chave)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON tab_painel_historico TO intranet;
