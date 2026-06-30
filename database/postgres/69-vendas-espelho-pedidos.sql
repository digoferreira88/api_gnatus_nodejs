-- Permissao exclusiva do "Espelho de Pedidos de Venda" (menu Vendas).
-- Atribuir a usuarios especificos que precisam visualizar os pedidos.
-- 2006 ja estava em uso (Custo e Margem da Carteira) — Espelho usa 2007.
INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo)
VALUES (2007, 'Vendas - Espelho de Pedidos', 'Vendas')
ON CONFLICT (id_permissao) DO NOTHING;
