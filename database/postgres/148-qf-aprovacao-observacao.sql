-- 148 — Qualificação de Fornecedores: observação do Gerente na aprovação em coluna própria.
--
-- Até aqui a aprovação gravava a observação do Gerente de Engenharia em
-- tab_qf_qualificacao.motivo (COALESCE), por cima do motivo de abertura do processo
-- (ex.: "Requalificação anual — vence em …"), e a ficha passava a mostrar a observação
-- com o rótulo "Motivo:". Agora:
--   - aprovacao_observacao guarda a observação da assinatura (aprovado OU reprovado);
--   - motivo continua sendo o de abertura; só a decisão NEGATIVA (reprovado / não
--     requalificado) o substitui, como já faz o encerramento pelo questionário < 50%.
-- Processos já aprovados ficam como estão (o motivo de abertura deles não é recuperável).
--
-- Aplicar ANTES de subir o backend novo (o UPDATE da aprovação usa a coluna). Idempotente.

ALTER TABLE tab_qf_qualificacao ADD COLUMN IF NOT EXISTS aprovacao_observacao TEXT;

COMMENT ON COLUMN tab_qf_qualificacao.aprovacao_observacao IS
  'Observação do Gerente de Engenharia na assinatura (aprovação/requalificação). O motivo de abertura fica em motivo.';

-- Inspeções importadas sem quantidade aprovada (em andamento na planilha, ex.: Rel. 21260–21302)
-- foram gravadas com "0% conforme". Sem a quantidade não há percentual: fica vazio até a
-- Qualidade completar o registro (a edição recalcula).
UPDATE tab_qf_inspecao SET pct_conforme = NULL
 WHERE qtd_aprovada IS NULL AND pct_conforme IS NOT NULL;
