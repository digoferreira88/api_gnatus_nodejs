-- Registra a permissão de Administração de Treinamentos (20001) no catálogo
-- (tab_intranet_permissoes) para aparecer na tela Editar Permissões, módulo "Treinamentos".
-- O catálogo/inscrição do colaborador é perm [] (todos autenticados) — não precisa de linha.

INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo)
VALUES (20001, 'Administração de Treinamentos', 'Treinamentos')
ON CONFLICT (id_permissao) DO NOTHING;
