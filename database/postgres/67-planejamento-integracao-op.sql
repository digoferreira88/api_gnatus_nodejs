-- A Integracao OP -> Pipefy migra do modulo Tecnologia para Planejamento e ganha
-- permissao EXCLUSIVA (3004), para ser atribuida a usuarios especificos alem do admin.
-- A permissao 1033 passa a cobrir apenas os webhooks Pipefy -> WhatsApp (segue em Tecnologia).

-- Nova permissao do gerenciamento OP -> Pipefy (modulo Planejamento, faixa 3xxx).
INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo)
VALUES (3004, 'Planejamento - Integração OP → Pipefy', 'Planejamento')
ON CONFLICT (id_permissao) DO NOTHING;

-- 1033 deixa de ser "OP -> Pipefy" e passa a ser so os webhooks -> WhatsApp.
UPDATE tab_intranet_permissoes
   SET nome = 'Tecnologia - Webhooks Pipefy → WhatsApp', modulo = 'Tecnologia'
 WHERE id_permissao = 1033;
