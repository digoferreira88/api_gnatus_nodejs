-- Permissao 2005: Ranking de Vendas (pedidos em aberto, distinto do Ranking
-- por Faturamento NF). Adicionado em 2026-05-13.

INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo) VALUES
  (2005, 'Vendas - Ranking de Vendas (pedidos em aberto)', 'Vendas')
ON CONFLICT (id_permissao) DO NOTHING;

-- Atribui ao admin (usuario id=1) caso nao tenha
INSERT INTO tab_intranet_usr_permissoes (id_user, id_permissao)
SELECT 1, 2005
 WHERE EXISTS (SELECT 1 FROM tab_intranet_usr WHERE id = 1)
   AND NOT EXISTS (
     SELECT 1 FROM tab_intranet_usr_permissoes
      WHERE id_user = 1 AND id_permissao = 2005
   );
