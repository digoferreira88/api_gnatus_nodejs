-- Permissão separada para o submenu "Histórico de Compras (Item)" da Controladoria
-- (01/09/2026). Antes compartilhava a 11002 (Custo de Produto), impedindo liberar
-- o histórico sem dar acesso ao custo. 11005 estava livre (a migration 87 reservava
-- "11001-11005 usados", mas 11005 nunca foi seedado). Idempotente.
INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo) VALUES
  (11005, 'Controladoria - Histórico de Compras (Item)', 'Controladoria')
ON CONFLICT (id_permissao) DO NOTHING;

-- Quem já tinha a 11002 (Custo de Produto) continua vendo o histórico: concede a
-- 11005 a todos que possuem a 11002, pra não tirar acesso de ninguém no corte.
INSERT INTO tab_intranet_usr_permissoes (id_user, id_permissao, matricula)
SELECT p.id_user, 11005, p.matricula
  FROM tab_intranet_usr_permissoes p
 WHERE p.id_permissao = 11002
ON CONFLICT DO NOTHING;
