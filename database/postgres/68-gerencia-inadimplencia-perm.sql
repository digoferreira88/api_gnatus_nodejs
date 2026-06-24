-- Permissao EXCLUSIVA da Inadimplencia por Safra (modulo Gerencia), separada do
-- DRE Gerencial (10001). Permite atribuir a tela a usuarios especificos (ex.:
-- cobranca/comercial) sem conceder acesso ao DRE Gerencial nem ao Dashboard de
-- Receita. A tela passa a depender SO da 10002 (+ admin) — quem tinha apenas a
-- 10001 deixa de ver a Inadimplencia ate receber a 10002.
INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo)
VALUES (10002, 'Gerência - Inadimplência por Safra', 'Gerência')
ON CONFLICT (id_permissao) DO NOTHING;
