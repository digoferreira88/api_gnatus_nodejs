-- NPS — campos adicionais do registro pedidos pelo CX:
--   empresa (nome fantasia SA1), produto adquirido (item predominante do pedido),
--   data do faturamento (emissão da NF). Os demais já existem: nome do cliente
--   (cliente_nome), CPF/CNPJ (cnpj), vendedor (vendedor_*), data da resposta
--   (respondido_em), respostas (tab_nps_resposta). Idempotente.

ALTER TABLE tab_nps_convite ADD COLUMN IF NOT EXISTS empresa          VARCHAR(200);
ALTER TABLE tab_nps_convite ADD COLUMN IF NOT EXISTS produto_cod      VARCHAR(30);
ALTER TABLE tab_nps_convite ADD COLUMN IF NOT EXISTS produto_desc     VARCHAR(200);
ALTER TABLE tab_nps_convite ADD COLUMN IF NOT EXISTS data_faturamento VARCHAR(8);   -- YYYYMMDD (emissão da NF)
