-- Inscrição pública (convidado sem conta na intranet) grava colaborador_id = NULL.
-- A coluna era NOT NULL (só previa colaborador logado). Torna anulável.
-- A identidade do convidado fica em colaborador_email/colaborador_nome + convite_id.

ALTER TABLE tab_treina_inscricao ALTER COLUMN colaborador_id DROP NOT NULL;
