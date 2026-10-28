-- 138 — Portal do cliente: PDF publicado e confirmação do pedido — 28/10/2026
--
-- Duas lacunas que apareceram quando o portal subiu de verdade:
--
-- 1. O cliente precisa BAIXAR o boleto, e o portal não pode pedir nada à
--    intranet (a conexão é sempre iniciada daqui). Então o PDF vai junto com o
--    espelho. `pdf_em` marca quando ele foi enviado, para não regerar e
--    reenviar ~400 PDFs em cada publicação.
--
-- 2. Os pedidos de 2ª via voltam na resposta da publicação, mas nada dizia ao
--    portal que o pedido chegou — ele reenviava o mesmo pedido para sempre.
--    `confirmado_em` registra a confirmação que mandamos de volta.

ALTER TABLE tab_portal_espelho
  ADD COLUMN IF NOT EXISTS pdf_em TIMESTAMPTZ;

COMMENT ON COLUMN tab_portal_espelho.pdf_em IS
  'Quando o PDF do boleto foi publicado no portal. NULL = ainda precisa gerar e enviar.';

-- O espelho é regravado inteiro a cada rodada; o índice parcial mantém barata a
-- pergunta "quais ainda devem PDF".
CREATE INDEX IF NOT EXISTS ix_portal_espelho_pdf_pendente
  ON tab_portal_espelho (id) WHERE pode_2via AND pdf_em IS NULL;

ALTER TABLE tab_boleto_2via_solicitacao
  ADD COLUMN IF NOT EXISTS confirmado_em TIMESTAMPTZ;

COMMENT ON COLUMN tab_boleto_2via_solicitacao.confirmado_em IS
  'Quando confirmamos ao portal que o pedido dele chegou nesta fila. NULL em pedido do portal = confirmar na próxima publicação.';

CREATE INDEX IF NOT EXISTS ix_2via_confirmar
  ON tab_boleto_2via_solicitacao (origem_id)
  WHERE origem = 'portal' AND origem_id IS NOT NULL AND confirmado_em IS NULL;
