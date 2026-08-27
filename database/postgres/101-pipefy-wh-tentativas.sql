-- Fila de WhatsApp do Pipefy (tab_pipefy_wh_fila): contador de tentativas p/ RETRY.
--
-- Contexto (27/08/2026): a Suri às vezes fica lenta e o envio estoura o timeout
-- (era 15s). A linha era marcada enviado='0' (falha) e NUNCA mais reprocessada —
-- a ATA/técnico ficavam sem a mensagem (card 1436504581). Agora falhas transitórias
-- são reenviadas até MAX tentativas, espaçadas ~1 min (o drenador é o próximo webhook).
ALTER TABLE tab_pipefy_wh_fila ADD COLUMN IF NOT EXISTS tentativas integer NOT NULL DEFAULT 0;
