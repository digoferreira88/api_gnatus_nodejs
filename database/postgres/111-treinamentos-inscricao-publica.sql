-- Inscrição de treinamento FORA da intranet (sem login): o convidado abre um link
-- público com token e escolhe a data. Suporta:
--   (1) link PESSOAL por convite  -> tab_treina_convite.token
--   (2) link PÚBLICO por treinamento (auto-atendimento) -> tab_treina_treinamento.public_token
-- A inscrição do convidado fica amarrada ao convite (convite_id) e é única por convite ativo.

ALTER TABLE tab_treina_convite     ADD COLUMN IF NOT EXISTS token        varchar(64);
ALTER TABLE tab_treina_treinamento ADD COLUMN IF NOT EXISTS public_token varchar(64);
ALTER TABLE tab_treina_inscricao   ADD COLUMN IF NOT EXISTS convite_id   integer REFERENCES tab_treina_convite(id) ON DELETE SET NULL;

-- Backfill dos registros existentes (gen_random_uuid é core no PG13+, sem extensão).
UPDATE tab_treina_convite
   SET token = replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','')
 WHERE token IS NULL OR token = '';
UPDATE tab_treina_treinamento
   SET public_token = replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','')
 WHERE public_token IS NULL OR public_token = '';

CREATE UNIQUE INDEX IF NOT EXISTS ux_treina_convite_token ON tab_treina_convite (token);
CREATE UNIQUE INDEX IF NOT EXISTS ux_treina_treino_ptoken ON tab_treina_treinamento (public_token);
-- Um convite (convidado) só pode ter 1 inscrição ativa — dedup do lado público.
CREATE UNIQUE INDEX IF NOT EXISTS ux_treina_insc_convite_ativa
    ON tab_treina_inscricao (convite_id) WHERE status = 'ativa' AND convite_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_treina_insc_convite ON tab_treina_inscricao (convite_id);
