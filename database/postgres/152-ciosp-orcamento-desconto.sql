-- 152 — CIOSP: desconto do orçamento e app do estande (Entrega 3 do CIOSP 2027) — 12/11/2026
--
-- O servidor passa a recalcular todo orçamento com a Tabela Comercial da edição. Preço
-- abaixo do mínimo (promoção + desconto livre) precisa do gerente: o vendedor pede a
-- aprovação pelo app e o gerente aprova ou recusa AQUELES preços (hash). Mudou item,
-- quantidade, preço, tabela ou forma, a aprovação deixa de valer.
-- Ver spec 2026-11-11-ciosp-estande-design.md, seções 4.6, 5 e 6.1.
--
-- Idempotente: pode rodar de novo sem efeito.

ALTER TABLE tab_ciosp_orcamento
  ADD COLUMN IF NOT EXISTS desconto_status        VARCHAR(10) NOT NULL DEFAULT 'livre',
  ADD COLUMN IF NOT EXISTS desconto_hash          VARCHAR(64),
  ADD COLUMN IF NOT EXISTS desconto_solicitado_em TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS desconto_por           INTEGER,
  ADD COLUMN IF NOT EXISTS desconto_em            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS desconto_obs           VARCHAR(300),
  -- Com que pacote (catálogo) o aparelho calculou, e quando o vendedor mexeu por último.
  ADD COLUMN IF NOT EXISTS versao_pacote          VARCHAR(40),
  ADD COLUMN IF NOT EXISTS aparelho_atualizado_em TIMESTAMPTZ;

COMMENT ON COLUMN tab_ciosp_orcamento.desconto_status IS
  'livre = dentro da promoção + desconto livre; pendente = precisa do gerente; aprovado/recusado = decisão do gerente para os preços do desconto_hash.';
COMMENT ON COLUMN tab_ciosp_orcamento.desconto_solicitado_em IS
  'Quando o vendedor pediu a aprovação. Pendente sem solicitação ainda não aparece para o gerente.';

-- "negociando" e "aprovado" saem: a aprovação de desconto vive em desconto_status.
UPDATE tab_ciosp_orcamento SET situacao = 'rascunho' WHERE situacao IN ('negociando', 'aprovado');

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_ciosp_orc_situacao') THEN
    ALTER TABLE tab_ciosp_orcamento ADD CONSTRAINT ck_ciosp_orc_situacao CHECK (situacao IN
      ('rascunho', 'enviado', 'convertido', 'perdido', 'expirado'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_ciosp_orc_desconto') THEN
    ALTER TABLE tab_ciosp_orcamento ADD CONSTRAINT ck_ciosp_orc_desconto CHECK (desconto_status IN
      ('livre', 'pendente', 'aprovado', 'recusado'));
  END IF;
END $$;

-- "O que mudou desde a última sincronização" do vendedor (GET /ciosp/estande/meus).
CREATE INDEX IF NOT EXISTS ix_ciosp_orc_meus ON tab_ciosp_orcamento (edicao, vendedor_id, atualizado_em);
CREATE INDEX IF NOT EXISTS ix_ciosp_ped_meus ON tab_ciosp_pedido (edicao, vendedor_id, atualizado_em);
