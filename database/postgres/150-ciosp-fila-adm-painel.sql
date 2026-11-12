-- 150 — CIOSP: fila do ADM e pedido → painel (Entrega 2 do CIOSP 2027) — 12/11/2026
--
-- O pedido do estande passa a ter um caminho: o vendedor envia, um ADM assume,
-- confere (ou devolve), registra crédito, contrato assinado e o nº do pedido no
-- Protheus, e finaliza. Ao conferir, o pedido vira uma linha "Pendente" no painel
-- (tab_ciosp_venda); ao finalizar, "Ok". Ver spec 2026-11-11-ciosp-estande-design.md,
-- seções 4.6, 6.2 e 6.3.
--
-- Idempotente: pode rodar de novo sem efeito.

-- ---------------------------------------------------------------- pedido
ALTER TABLE tab_ciosp_pedido
  ADD COLUMN IF NOT EXISTS tabela_comissao       SMALLINT,
  ADD COLUMN IF NOT EXISTS forma_pagto_id        INTEGER REFERENCES tab_ciosp_forma_pagto(id),
  ADD COLUMN IF NOT EXISTS origem                VARCHAR(12) DEFAULT 'Presencial',
  ADD COLUMN IF NOT EXISTS enviado_em            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS adm_responsavel       INTEGER,
  ADD COLUMN IF NOT EXISTS adm_assumiu_em        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS conferido_por         INTEGER,
  ADD COLUMN IF NOT EXISTS conferido_em          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS devolvido_motivo      VARCHAR(300),
  ADD COLUMN IF NOT EXISTS credito_status        VARCHAR(10),
  ADD COLUMN IF NOT EXISTS credito_parecer       VARCHAR(500),
  ADD COLUMN IF NOT EXISTS credito_por           INTEGER,
  ADD COLUMN IF NOT EXISTS credito_em            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS contrato_assinado_por INTEGER,
  ADD COLUMN IF NOT EXISTS contrato_assinado_em  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS protheus_conferido    VARCHAR(14),
  ADD COLUMN IF NOT EXISTS protheus_conferido_em TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS finalizado_por        INTEGER,
  ADD COLUMN IF NOT EXISTS finalizado_em         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelado_por         INTEGER,
  ADD COLUMN IF NOT EXISTS cancelado_em          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS venda_id              INTEGER,
  -- Ajustes do ADM para a linha do painel; vazio = vem da equipe do evento.
  ADD COLUMN IF NOT EXISTS painel_categoria      VARCHAR(20),
  ADD COLUMN IF NOT EXISTS painel_gerente        VARCHAR(120),
  ADD COLUMN IF NOT EXISTS painel_equipe         VARCHAR(120);

-- Situações do esboço de outubro (conferido/impresso/integrado eram marcadas pelo
-- próprio vendedor, sem ADM) voltam a rascunho. Pedido conferido pelo fluxo novo tem
-- conferido_em, então rodar de novo não mexe nele.
UPDATE tab_ciosp_pedido SET situacao = 'rascunho'
 WHERE situacao IN ('conferido', 'impresso', 'integrado') AND conferido_em IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_ciosp_ped_situacao') THEN
    ALTER TABLE tab_ciosp_pedido ADD CONSTRAINT ck_ciosp_ped_situacao CHECK (situacao IN
      ('rascunho', 'enviado', 'em_analise', 'devolvido', 'conferido', 'finalizado', 'cancelado'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_ciosp_ped_tabela') THEN
    ALTER TABLE tab_ciosp_pedido ADD CONSTRAINT ck_ciosp_ped_tabela CHECK (tabela_comissao IN (13, 11));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_ciosp_ped_origem') THEN
    ALTER TABLE tab_ciosp_pedido ADD CONSTRAINT ck_ciosp_ped_origem CHECK (origem IN ('Presencial', 'Online'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_ciosp_ped_credito') THEN
    ALTER TABLE tab_ciosp_pedido ADD CONSTRAINT ck_ciosp_ped_credito CHECK (credito_status IN
      ('nao_exige', 'pendente', 'aprovado', 'recusado'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_ciosp_ped_protheus') THEN
    ALTER TABLE tab_ciosp_pedido ADD CONSTRAINT ck_ciosp_ped_protheus CHECK (protheus_conferido IN
      ('ok', 'divergente', 'nao_encontrado', 'nao_conferido'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_ciosp_ped_painel_cat') THEN
    ALTER TABLE tab_ciosp_pedido ADD CONSTRAINT ck_ciosp_ped_painel_cat CHECK (painel_categoria IN
      ('EQUIPAMENTOS', 'DIGITAL', 'AT'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_ciosp_ped_fila ON tab_ciosp_pedido (edicao, situacao, enviado_em);

COMMENT ON COLUMN tab_ciosp_pedido.enviado_em IS
  'Primeiro envio ao ADM. É a data da venda no painel; reenviar após devolução não muda.';
COMMENT ON COLUMN tab_ciosp_pedido.venda_id IS
  'Linha do painel (tab_ciosp_venda) criada ao conferir; some ao devolver ou cancelar.';

-- ---------------------------------------------------------------- orçamento
ALTER TABLE tab_ciosp_orcamento
  ADD COLUMN IF NOT EXISTS tabela_comissao SMALLINT,
  ADD COLUMN IF NOT EXISTS forma_pagto_id  INTEGER REFERENCES tab_ciosp_forma_pagto(id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_ciosp_orc_tabela') THEN
    ALTER TABLE tab_ciosp_orcamento ADD CONSTRAINT ck_ciosp_orc_tabela CHECK (tabela_comissao IN (13, 11));
  END IF;
END $$;

-- ---------------------------------------------------------------- itens
-- A linha da Tabela Comercial e a promoção acompanham o item: é o que o ADM confere
-- (promoção condicional) e o que mede desconto por linha. A descrição dos
-- consultórios passa de 700 caracteres.
ALTER TABLE tab_ciosp_orcamento_item
  ADD COLUMN IF NOT EXISTS preco_id             INTEGER,
  ADD COLUMN IF NOT EXISTS promocao_pct         NUMERIC(6,2),
  ADD COLUMN IF NOT EXISTS promocao_texto       VARCHAR(300),
  ADD COLUMN IF NOT EXISTS promocao_condicional BOOLEAN NOT NULL DEFAULT FALSE,
  ALTER COLUMN descricao TYPE TEXT;

ALTER TABLE tab_ciosp_pedido_item
  ADD COLUMN IF NOT EXISTS preco_id             INTEGER,
  ADD COLUMN IF NOT EXISTS promocao_pct         NUMERIC(6,2),
  ADD COLUMN IF NOT EXISTS promocao_texto       VARCHAR(300),
  ADD COLUMN IF NOT EXISTS promocao_condicional BOOLEAN NOT NULL DEFAULT FALSE,
  ALTER COLUMN descricao TYPE TEXT;

-- ---------------------------------------------------------------- painel
-- Linha com pedido_id é do pedido: a tela de Lançamentos não edita nem exclui.
ALTER TABLE tab_ciosp_venda
  ADD COLUMN IF NOT EXISTS pedido_id INTEGER REFERENCES tab_ciosp_pedido(id);

CREATE UNIQUE INDEX IF NOT EXISTS ux_ciosp_venda_pedido
  ON tab_ciosp_venda (pedido_id) WHERE pedido_id IS NOT NULL;
