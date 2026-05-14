-- 45-producao-anexo-sharepoint.sql
-- Estende tab_prod_registro_anexo pra suportar anexos binarios via SharePoint
-- (em vez de so URL externa). Mantem retrocompatibilidade: anexos antigos
-- com origem='url_externa' continuam funcionando, novos uploads usam
-- origem='sharepoint' e populam drive_id/item_id/path/mime/tamanho.

ALTER TABLE tab_prod_registro_anexo
  ADD COLUMN IF NOT EXISTS origem               varchar(20) NOT NULL DEFAULT 'url_externa',
  ADD COLUMN IF NOT EXISTS sharepoint_drive_id  text,
  ADD COLUMN IF NOT EXISTS sharepoint_item_id   text,
  ADD COLUMN IF NOT EXISTS sharepoint_path      text,
  ADD COLUMN IF NOT EXISTS nome_original        varchar(300),
  ADD COLUMN IF NOT EXISTS mime_type            varchar(120),
  ADD COLUMN IF NOT EXISTS tamanho_bytes        bigint;

-- Marca anexos antigos (criados antes desta migration) como url externa.
-- Ja sao por default mas explicito ajuda em backfill.
UPDATE tab_prod_registro_anexo
   SET origem = 'url_externa'
 WHERE origem IS NULL OR origem = '';

-- Indice pra acelerar lookup por sharepoint_item_id (ex: deduplicar uploads)
CREATE INDEX IF NOT EXISTS ix_prod_anexo_sp_item
  ON tab_prod_registro_anexo (sharepoint_item_id)
  WHERE sharepoint_item_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON tab_prod_registro_anexo TO intranet;
