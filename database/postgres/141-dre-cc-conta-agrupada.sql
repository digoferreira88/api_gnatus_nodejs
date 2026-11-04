-- DRE por Centro de Custo: contas sensíveis passam de OCULTAS para AGRUPADAS. Idempotente.
--
-- Contexto (04/11/2026): até aqui as contas de tab_dre_conta_oculta (seed:
-- 41100010020 HONORÁRIOS DE SERVIÇOS TOMADOS) sumiam da visão do gestor restrito
-- (perm 10003) e de TODOS os totais dele. A diretoria pediu que o valor ENTRE no gasto
-- do centro de custo, mas aparecendo numa ÚNICA linha com o total, sem abrir
-- prestador/lançamento.
--
-- A tabela continua a mesma (o nome ficou histórico); muda só o comportamento no
-- endpoint /gerencia/dre/centro-custo. `rotulo` é o nome que o gestor vê na linha
-- consolidada — contas com o mesmo rótulo somam na mesma linha. A visão completa
-- (10001/0) não muda: segue mostrando a conta normal, com todo o detalhe.

ALTER TABLE tab_dre_conta_oculta ADD COLUMN IF NOT EXISTS rotulo VARCHAR(120);

UPDATE tab_dre_conta_oculta
   SET rotulo = 'SALÁRIOS – PRESTADORES DE SERVIÇO'
 WHERE conta = '41100010020' AND rotulo IS NULL;

COMMENT ON TABLE tab_dre_conta_oculta IS
  'DRE CC: contas mostradas ao gestor restrito (10003) só como total numa linha consolidada (rotulo), sem detalhe. Entram nos totais.';
COMMENT ON COLUMN tab_dre_conta_oculta.rotulo IS
  'Nome da linha consolidada vista pelo gestor. Contas com o mesmo rótulo somam juntas.';
