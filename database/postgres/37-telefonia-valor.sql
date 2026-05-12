-- Tecnologia - Linhas Moveis: valor mensal por linha
-- Permite totalizar custo mensal (soma de ativas) no dashboard.

ALTER TABLE tab_telefonia_linha
    ADD COLUMN IF NOT EXISTS valor_mensal numeric(10,2);

COMMENT ON COLUMN tab_telefonia_linha.valor_mensal IS
    'Custo mensal da linha (R$). Usado no totalizador do dashboard.';
