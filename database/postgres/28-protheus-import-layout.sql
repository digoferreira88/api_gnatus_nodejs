-- Tecnologia - Importacao Protheus: layouts salvos por usuario
-- Permite que cada operador salve combinacoes de tabela + campos selecionados
-- pra reuso (sem precisar montar a estrutura toda vez).

CREATE TABLE IF NOT EXISTS tab_protheus_import_layout (
    id              SERIAL PRIMARY KEY,
    nome            varchar(100) NOT NULL,         -- ex: "Cliente PJ basico"
    modelo_id       int NOT NULL,                  -- ID TRPWSIMP (1..99)
    modelo_nome     varchar(100),
    tabela          varchar(10) NOT NULL,          -- SA1, SB1, etc
    campos          jsonb NOT NULL,                -- [{ campo, titulo, tipo, tamanho, decimal, obrigatorio }]
    notas           text,
    -- Compartilhamento: 'private' (so o dono ve) | 'public' (todos com perm 1031 veem)
    visibilidade    varchar(10) NOT NULL DEFAULT 'private',
    -- Meta
    criado_por      int NOT NULL REFERENCES tab_intranet_usr(id) ON DELETE CASCADE,
    criado_em       timestamp NOT NULL DEFAULT NOW(),
    atualizado_em   timestamp NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pti_layout_user   ON tab_protheus_import_layout (criado_por, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_pti_layout_tabela ON tab_protheus_import_layout (tabela);
