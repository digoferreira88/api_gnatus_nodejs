-- NPS Pós-venda — TRAVA SAC. Antes do disparo automático, cruza o CPF/CNPJ do
-- cliente com o pipe de reclamações do Atendimento ao Consumidor. Se houver card
-- ABERTO (fora do "Concluído"), o convite fica em status 'REVISAO' (novo valor;
-- status é VARCHAR(12), cabe) e o operador decide manualmente na aba Envios.
-- Colunas guardam as ocorrências achadas e quando foi verificado. Idempotente.

ALTER TABLE tab_nps_convite ADD COLUMN IF NOT EXISTS sac_ocorrencias   JSONB;
ALTER TABLE tab_nps_convite ADD COLUMN IF NOT EXISTS sac_verificado_em TIMESTAMPTZ;
