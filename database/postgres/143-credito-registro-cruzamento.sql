-- Registro de Análise de Crédito — cruzamento por CPF/CNPJ, condições liberadas
-- e data de recebimento da solicitação (produtividade).
--
-- 1) documento: CPF/CNPJ só com dígitos, CALCULADO a partir de `cnpj` (o campo
--    antigo era texto livre: com ou sem máscara). É a chave do cruzamento — avisa
--    quando o mesmo CPF/CNPJ já foi analisado e liga a análise à anterior.
-- 2) cond_*: condições liberadas para o cliente (forma de pagamento, valor máximo,
--    entrada mínima, parcelas, validade, observação). Só preenchidas em aprovações.
-- 3) solicitado_em: quando a solicitação chegou (manual) — mede o tempo de resposta.
-- 4) anterior_grupo_id: análise anterior do mesmo CPF/CNPJ no momento do registro.
--    duplicidade_confirmada: o analista registrou mesmo havendo análise recente.
--
-- Sem permissão nova: a produtividade das análises usa a 8008 (produtividade da
-- equipe), que já existe. Idempotente. Rodar como `intranet`, ou como postgres
-- passando o arquivo pela entrada padrão (as colunas herdam o GRANT da tabela).

ALTER TABLE tab_credito_registro
  ADD COLUMN IF NOT EXISTS documento VARCHAR(20)
    GENERATED ALWAYS AS (NULLIF(regexp_replace(COALESCE(cnpj, ''), '[^0-9]', '', 'g'), '')) STORED;

ALTER TABLE tab_credito_registro ADD COLUMN IF NOT EXISTS cond_forma_pagamento  VARCHAR(40);
ALTER TABLE tab_credito_registro ADD COLUMN IF NOT EXISTS cond_valor_max        NUMERIC(15,2);
ALTER TABLE tab_credito_registro ADD COLUMN IF NOT EXISTS cond_entrada_min_pct  NUMERIC(5,2);
ALTER TABLE tab_credito_registro ADD COLUMN IF NOT EXISTS cond_parcelas_max     INTEGER;
ALTER TABLE tab_credito_registro ADD COLUMN IF NOT EXISTS cond_validade         DATE;
ALTER TABLE tab_credito_registro ADD COLUMN IF NOT EXISTS cond_observacao       VARCHAR(500);
ALTER TABLE tab_credito_registro ADD COLUMN IF NOT EXISTS solicitado_em         TIMESTAMPTZ;
ALTER TABLE tab_credito_registro ADD COLUMN IF NOT EXISTS anterior_grupo_id     INTEGER;
ALTER TABLE tab_credito_registro ADD COLUMN IF NOT EXISTS duplicidade_confirmada BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS ix_credito_registro_documento
  ON tab_credito_registro (documento, criado_em DESC) WHERE vigente;

-- Liga as análises já existentes à anterior do mesmo CPF/CNPJ (ordem de registro).
WITH g AS (
  SELECT grupo_id,
         LAG(grupo_id) OVER (PARTITION BY documento ORDER BY criado_em, grupo_id) AS ant
    FROM tab_credito_registro
   WHERE versao = 1 AND documento IS NOT NULL
)
UPDATE tab_credito_registro r
   SET anterior_grupo_id = g.ant
  FROM g
 WHERE r.grupo_id = g.grupo_id AND g.ant IS NOT NULL AND r.anterior_grupo_id IS NULL;

-- A 8008 passa a cobrir também a produtividade das análises de crédito.
UPDATE tab_intranet_permissoes
   SET nome = 'Financeiro - Produtividade da equipe (liberações e análises de crédito)'
 WHERE id_permissao = 8008;

COMMENT ON COLUMN tab_credito_registro.documento IS 'CPF/CNPJ só dígitos (calculado de cnpj) — chave do cruzamento anti-duplicidade.';
COMMENT ON COLUMN tab_credito_registro.solicitado_em IS 'Quando a solicitação chegou ao crédito (informado pelo analista) — tempo de resposta.';
