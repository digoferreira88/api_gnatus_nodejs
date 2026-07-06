-- Anexos de consultas externas na Análise de Crédito (ex.: PDF do Serasa/Boa Vista
-- consultado manualmente pelo time). Arquivo vai pro SharePoint (/sites/Pipefy,
-- pasta "Credito Consultas/..."), aqui fica só o metadata. Idempotente.
-- Usa as permissões existentes do módulo (15100); sem perm nova.

CREATE TABLE IF NOT EXISTS tab_credito_anexo (
  id                  SERIAL PRIMARY KEY,
  cliente_cod         VARCHAR(30) NOT NULL,
  cliente_loja        VARCHAR(10) NOT NULL,
  titulo              TEXT NOT NULL,
  nome_original       TEXT,
  mime_type           TEXT,
  tamanho_bytes       BIGINT,
  sharepoint_drive_id TEXT,
  sharepoint_item_id  TEXT,
  sharepoint_path     TEXT,
  url                 TEXT,               -- web_url do SharePoint (preview)
  enviado_por         INTEGER REFERENCES tab_intranet_usr(id),
  enviado_em          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_credito_anexo_cliente
  ON tab_credito_anexo (cliente_cod, cliente_loja, enviado_em DESC);

-- Sem isso o backend (role intranet) leva "permission denied" quando a migration
-- roda como postgres (ver §8 do manual). Idempotente.
GRANT SELECT, INSERT, UPDATE, DELETE ON tab_credito_anexo TO intranet;
GRANT USAGE, SELECT ON SEQUENCE tab_credito_anexo_id_seq TO intranet;
