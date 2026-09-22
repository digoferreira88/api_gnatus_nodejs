-- 121 — Painel de Estoque (Compras) — 22/09/2026
--
-- O setor de Compras construiu um painel HTML alimentado por 3 uploads diários
-- (posição de estoque, pedidos de compra, carteira). A intranet passa a servir os
-- mesmos dados direto do Protheus (services/painelEstoqueCompras.js), e o upload sai.
-- Contrato e regras: docs/compras/Painel_Estoque_GNATUS_Contexto.md
--
-- Aqui só o apoio:
--   1) valor empenhado no fechamento mensal — o gráfico do painel alterna entre valor
--      em estoque e valor empenhado, e o snapshot só guardava o de estoque;
--   2) permissão da tela.

ALTER TABLE tab_estoque_snapshot_mensal
  ADD COLUMN IF NOT EXISTS valor_empenho NUMERIC(14,2);

COMMENT ON COLUMN tab_estoque_snapshot_mensal.valor_empenho IS
  'Valor empenhado no fechamento (B2_QEMP x B2_CM1). Gravado a partir de 22/09/2026; meses anteriores ficam NULL até a carga do histórico que Compras mantém em planilha.';

INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo)
VALUES (4007, 'Compras - Painel de Estoque', 'Compras')
ON CONFLICT (id_permissao) DO NOTHING;
