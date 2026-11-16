-- 153 — CIOSP: inserir o pedido no Protheus pela fila do ADM — 16/11/2026
--
-- O ADM deixa de digitar o pedido no Protheus e informar o número: um botão
-- "Inserir no Protheus e finalizar" chama o REST do Diego (PedidoVenda/incluir),
-- que cadastra o cliente se faltar, cria o pedido e devolve o número. Cada tentativa
-- fica registrada (o que o ADM escolheu, o que foi enviado e o que voltou).
-- Ver spec 2026-11-13-ciosp-inserir-protheus-design.md, seção 6.1.
--
-- Idempotente: pode rodar de novo sem efeito.

-- ---------------------------------------------------------------- equipe e formas
-- Vendedor (A3_COD) e BU (C5_ZTIPO, SX5 Z1) de cada pessoa da equipe do evento.
ALTER TABLE tab_ciosp_equipe
  ADD COLUMN IF NOT EXISTS protheus_vendedor VARCHAR(6),
  ADD COLUMN IF NOT EXISTS protheus_bu       VARCHAR(3);

-- Condição de pagamento (E4_CODIGO) de cada forma. "Parcelada": a condição varia
-- pelas parcelas (cartão: 400 → 10x = 409). protheus_forma = C5_FORMAPG (SX5 Z2).
ALTER TABLE tab_ciosp_forma_pagto
  ADD COLUMN IF NOT EXISTS protheus_condicao           VARCHAR(3),
  ADD COLUMN IF NOT EXISTS protheus_condicao_parcelada BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS protheus_forma              VARCHAR(1);

-- ---------------------------------------------------------------- pedido
ALTER TABLE tab_ciosp_pedido
  ADD COLUMN IF NOT EXISTS cliente_genero          CHAR(1),          -- F | M (pessoa física)
  ADD COLUMN IF NOT EXISTS cliente_nascimento      DATE,             -- nascimento (PF) ou abertura (PJ)
  ADD COLUMN IF NOT EXISTS protheus_envio          VARCHAR(10),      -- nulo = nunca enviado pelo botão
  ADD COLUMN IF NOT EXISTS protheus_envio_em       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS protheus_envio_por      INTEGER,
  ADD COLUMN IF NOT EXISTS protheus_tentativas     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS protheus_cliente_criado BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_ciosp_ped_genero') THEN
    ALTER TABLE tab_ciosp_pedido ADD CONSTRAINT ck_ciosp_ped_genero CHECK (cliente_genero IN ('F', 'M'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_ciosp_ped_protheus_envio') THEN
    ALTER TABLE tab_ciosp_pedido ADD CONSTRAINT ck_ciosp_ped_protheus_envio CHECK (protheus_envio IN
      ('enviando', 'criado', 'recusado', 'incerto'));
  END IF;
END $$;

-- ---------------------------------------------------------------- tentativas
CREATE TABLE IF NOT EXISTS tab_ciosp_protheus_envio (
  id           SERIAL PRIMARY KEY,
  pedido_id    INTEGER     NOT NULL REFERENCES tab_ciosp_pedido(id),
  tentativa    INTEGER     NOT NULL,
  enviado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  enviado_por  INTEGER,
  simulado     BOOLEAN     NOT NULL DEFAULT FALSE,
  escolhas     JSONB       NOT NULL,                -- o que o ADM escolheu no painel (pré-preenche a próxima)
  payload      JSONB       NOT NULL,                -- o corpo enviado ao Protheus
  http         INTEGER,
  resposta     JSONB,
  resultado    VARCHAR(12),
  duracao_ms   INTEGER
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_ciosp_pv_resultado') THEN
    ALTER TABLE tab_ciosp_protheus_envio ADD CONSTRAINT ck_ciosp_pv_resultado CHECK (resultado IN
      ('criado', 'ja_existia', 'recusado', 'sem_licenca', 'incerto'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_ciosp_pv_envio ON tab_ciosp_protheus_envio (pedido_id, tentativa DESC);
