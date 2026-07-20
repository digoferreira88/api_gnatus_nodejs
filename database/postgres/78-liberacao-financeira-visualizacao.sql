-- Liberação Financeira — permissão de SOMENTE VISUALIZAÇÃO (8007).
-- Quem já tem a 8006 (acesso completo) permanece exatamente como está; a 8007 é
-- adicional e dá acesso apenas de LEITURA à tela (fila, detalhe do pedido,
-- painel de crédito, histórico e os registros de análise), SEM poder gravar:
--   - anotações (ações/observações) do pedido
--   - registrar/editar análise de crédito
--   - anexar/remover documentos
-- Idempotente.

INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo)
VALUES (8007, 'Financeiro - Liberação Financeira (somente visualização)', 'Financeiro')
ON CONFLICT (id_permissao) DO NOTHING;
