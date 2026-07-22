-- NPS Pós-venda — canal de e-mail (tratativa do CX). Rastreia o reenvio do link
-- da pesquisa por e-mail a partir da caixa cx@gnatus.com.br (aba "Envios").
-- Idempotente (IF NOT EXISTS) — seguro reaplicar.

ALTER TABLE tab_nps_convite ADD COLUMN IF NOT EXISTS email_enviado_em TIMESTAMPTZ;
ALTER TABLE tab_nps_convite ADD COLUMN IF NOT EXISTS email_destino     TEXT;
