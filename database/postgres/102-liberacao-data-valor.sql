-- Liberação Financeira: 2 campos manuais na anotação do pedido (01/09/2026).
-- data_acao = data que o operador combina/executa a ação (não é o atualizado_em);
-- valor_atraso = valor em atraso digitado na negociação. Idempotente.
ALTER TABLE tab_lib_financeira_anotacao ADD COLUMN IF NOT EXISTS data_acao    DATE;
ALTER TABLE tab_lib_financeira_anotacao ADD COLUMN IF NOT EXISTS valor_atraso NUMERIC(15,2);
