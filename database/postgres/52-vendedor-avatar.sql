-- Avatares de vendedores armazenados como BLOB (bytea) — vinculados ao A3_COD
-- da SA3 do Protheus. Servidos via endpoint GET /tecnologia/vendedor-avatar/:cod
-- com headers de cache (ETag, max-age) pro browser nao re-buscar sempre.
--
-- Substitui o esquema antigo de arquivos estaticos em frontend/public/avatars/vendedores/
-- (que era fragil a redeploys). Os 38 avatares atuais sao migrados via script
-- standalone backend/scripts/migrar-avatares-iniciais.js (idempotente, ON CONFLICT
-- DO NOTHING). Apos a migracao inicial, a UI de tecnologia faz o CRUD.

CREATE TABLE IF NOT EXISTS tab_vendedor_avatar (
    codigo          varchar(20) PRIMARY KEY,    -- SA3.A3_COD (com zeros a esquerda)
    nome            varchar(120),                -- snapshot do A3_NOME no momento do upload
    mime_type       varchar(60)  NOT NULL,
    tamanho_bytes   int          NOT NULL,
    bytes           bytea        NOT NULL,
    atualizado_por  int REFERENCES tab_intranet_usr(id) ON DELETE SET NULL,
    criado_em       timestamp    NOT NULL DEFAULT NOW(),
    atualizado_em   timestamp    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_vendedor_avatar_at ON tab_vendedor_avatar (atualizado_em DESC);
