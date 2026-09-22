-- 119 — Permissão dedicada da Comissão de cobrança no catálogo (tela Editar
-- Permissões). Antes a aba usava a 9005 ("Filtro escondido"), o que confundia.
-- 9006 = gestão da comissão (ver/config/fechar). Idempotente.
INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo)
SELECT 9006, 'Cobrança - Comissão (gestão)', 'Cobrança'
 WHERE NOT EXISTS (SELECT 1 FROM tab_intranet_permissoes WHERE id_permissao = 9006);
