-- Permissao exclusiva do "Espelho de Pedidos de Venda" (menu Vendas).
-- Atribuir a usuarios especificos que precisam visualizar os pedidos.
INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo)
VALUES (2006, 'Vendas - Espelho de Pedidos', 'Vendas')
ON CONFLICT (id_permissao) DO NOTHING;
