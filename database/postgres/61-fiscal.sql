-- Módulo Fiscal — permissão (painel gerencial: documentos, tributário, fila de
-- faturamento). Idempotente.
INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo) VALUES
  (16001, 'Fiscal - Painel Gerencial', 'Fiscal')
ON CONFLICT (id_permissao) DO NOTHING;
