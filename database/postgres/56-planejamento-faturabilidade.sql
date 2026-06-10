-- Permissao do dashboard de Faturabilidade (Planejamento). Idempotente.
INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo)
SELECT 3002, 'Planejamento - Faturabilidade', 'Planejamento'
WHERE NOT EXISTS (SELECT 1 FROM tab_intranet_permissoes WHERE id_permissao = 3002);
