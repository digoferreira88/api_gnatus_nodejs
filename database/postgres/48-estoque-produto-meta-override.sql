-- 48-estoque-produto-meta-override.sql
-- Permite cadastro MANUAL (override) de lead time, demanda media e estoque
-- de seguranca por produto. Quando preenchido, ganha do calculo automatico
-- do dashboard de Qualidade.
--
-- Estrategia: estende tab_estoque_produto_meta com colunas *_override e
-- demanda/seguranca manuais. O cron diario continua mantendo o lead_time_dias
-- do Protheus (B1_PE); o backend usa o override se nao for NULL.

ALTER TABLE tab_estoque_produto_meta
  ADD COLUMN IF NOT EXISTS lead_time_override        int,
  ADD COLUMN IF NOT EXISTS demanda_mensal_manual     numeric(15,4),
  ADD COLUMN IF NOT EXISTS estoque_seguranca_manual  numeric(15,4),
  ADD COLUMN IF NOT EXISTS observacao_manual         text,
  ADD COLUMN IF NOT EXISTS atualizado_por            int REFERENCES tab_intranet_usr(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS manual_em                 timestamp;

CREATE INDEX IF NOT EXISTS ix_est_pmeta_manual
  ON tab_estoque_produto_meta (cod_produto)
  WHERE lead_time_override IS NOT NULL
     OR demanda_mensal_manual IS NOT NULL
     OR estoque_seguranca_manual IS NOT NULL;

COMMENT ON COLUMN tab_estoque_produto_meta.lead_time_override IS
  'Override manual do lead time. Quando NOT NULL, eh usado em vez do B1_PE.';
COMMENT ON COLUMN tab_estoque_produto_meta.demanda_mensal_manual IS
  'Demanda media mensal manual. Quando NOT NULL, eh usada em vez da media calculada do snapshot.';
COMMENT ON COLUMN tab_estoque_produto_meta.estoque_seguranca_manual IS
  'Estoque de seguranca manual. Quando NOT NULL, eh usado em vez do calculo z*sigma*sqrt(lt).';

GRANT SELECT, INSERT, UPDATE, DELETE ON tab_estoque_produto_meta TO intranet;
