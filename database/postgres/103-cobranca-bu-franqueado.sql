-- Duas novas BUs criadas no Protheus (SX5 tabela Z1, já com descrição):
--   FRP -> FRANQUEADOS PRODUTOS
--   FRO -> FRANQUEADO OUTLET
-- O nome já resolve sozinho na intranet (todos os pontos leem X5_DESCRI da SX5).
-- Falta só o de-para BU -> equipe (tab_cobranca_bu_equipe), senão elas caem como
-- "Sem equipe" na Carteira de Cobrança e em B2B no Fat x Inad.
--
-- Decisão do usuário (04/09/2026): ambas rolam para a equipe FRANQUIAS
-- (perfil ATACADO, meta de inadimplência <= 2%, igual FRANQUIAS/FRANQUIAS TAXAS).
--
-- A CHAVE (bu_codigo) é o LABEL exatamente como o backend formata (X5_DESCRI),
-- não o código FRP/FRO — igual ao resto do seed de 11-cobranca-bu-equipe.sql.
-- DO UPDATE (e não DO NOTHING) para garantir o mapeamento confirmado mesmo que
-- a linha já tenha sido criada à mão pela tela BU->Equipe (com perfil nulo).

INSERT INTO tab_cobranca_bu_equipe (bu_codigo, equipe, perfil) VALUES
  ('FRANQUEADOS PRODUTOS', 'Franquias', 'Atacado'),
  ('FRANQUEADO OUTLET',    'Franquias', 'Atacado')
ON CONFLICT (bu_codigo) DO UPDATE SET
  equipe = EXCLUDED.equipe,
  perfil = EXCLUDED.perfil,
  atualizado_em = NOW();
