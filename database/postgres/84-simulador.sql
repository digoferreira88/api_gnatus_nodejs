-- ============================================================================
-- Módulo Simulador de Margens (franqueado)
--
-- Trazido pra DENTRO da intranet (antes standalone em simulador.gnatus.com.br,
-- Docker/nginx, sem login). Agora é um módulo GATED por login + permissão.
--
-- O app é o MESMO (index.html + calc.js, idênticos) — servido inline por
-- resources/simulador/simulador.app.js (autenticado, perm 17001) e embutido
-- num iframe pela tela React /simulador.
--
-- Permissão:
--   17001 = Simulador - Margens
-- ============================================================================

INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo)
VALUES (17001, 'Simulador - Margens', 'Simulador')
ON CONFLICT (id_permissao) DO UPDATE
   SET nome = EXCLUDED.nome, modulo = EXCLUDED.modulo;

-- Concede ao admin (pra não ficar sem ninguém); os demais são atribuídos na
-- Gestão de Usuários da intranet.
INSERT INTO tab_intranet_usr_permissoes (id_user, id_permissao, matricula)
SELECT u.id, 17001, u.matricula FROM tab_intranet_usr u WHERE u.email = 'admin@gnatus.com.br'
ON CONFLICT (id_user, id_permissao) DO NOTHING;
