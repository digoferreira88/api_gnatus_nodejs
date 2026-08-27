-- Permissão para ALTERAR a previsão de entrega (C7_DATPRF) do pedido de compra
-- direto na tela de Pedidos de Compra. Separada da 4002 (consulta) porque é
-- ESCRITA no Protheus — quem consulta não necessariamente pode alterar.
-- Porta o módulo da intranet antiga (/compras/pedidos/edit), que gravava direto
-- na SC7010 justamente para o pedido NÃO voltar à alçada de aprovação.

INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo) VALUES
  (4006, 'Compras - Alterar previsão de entrega do PC', 'Compras')
ON CONFLICT (id_permissao) DO NOTHING;
