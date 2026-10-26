-- Liberação Financeira — aba "Produtividade da equipe" (permissão 8008).
--
-- Mostra quem liberou cada pedido no Financeiro (Liberação Financeira e de Risco),
-- quanto tempo o pedido esperou na fila e o volume por colaborador, a partir do log
-- de liberações do Protheus (SZ5010). É dado de desempenho individual, por isso tem
-- permissão própria — destinada ao gestor.
--
-- COMPLEMENTA a 8006/8007: a aba fica dentro da tela de Liberação Financeira, que
-- só abre para quem tem uma das duas. Quem recebe a 8008 precisa ter também a 8006
-- ou a 8007. Admin (0) vê sempre. Não cria tabela. Idempotente.

INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo)
VALUES (8008, 'Financeiro - Liberação Financeira (produtividade da equipe)', 'Financeiro')
ON CONFLICT (id_permissao) DO NOTHING;
