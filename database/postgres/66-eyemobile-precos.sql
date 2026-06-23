-- Permissão do importador de preços EyeMobile (tela "Atualizar Preços EyeMobile").
INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo)
VALUES (16100, 'EyeMobile - Atualização de Preços', 'EyeMobile')
ON CONFLICT (id_permissao) DO NOTHING;
