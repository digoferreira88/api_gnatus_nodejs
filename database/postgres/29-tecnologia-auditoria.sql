-- Tecnologia - Auditoria centralizada
-- Registra acoes criticas de qualquer modulo (login, mudanca de permissao,
-- CRUD do Cofre, provisionamento AD/M365, aprovacoes Compras, importacoes
-- Protheus, envios WhatsApp etc).
--
-- Sem expiracao — logs ficam indefinidamente pra atender LGPD/compliance.

-- pg_trgm: necessario pro indice de busca textual em descricao (criado abaixo)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS tab_auditoria (
    id              BIGSERIAL PRIMARY KEY,
    -- Categoria
    modulo          varchar(40)  NOT NULL,         -- 'Tecnologia' | 'Cobranca' | 'Compras' | 'Cofre' | etc
    submodulo       varchar(60),                    -- 'Permissoes' | 'GestaoUsuarios' | 'Aprovacoes' | etc
    acao            varchar(30)  NOT NULL,         -- 'CREATE' | 'UPDATE' | 'DELETE' | 'EXECUTE' | 'LOGIN' | 'LOGIN_FAIL' | 'APPROVE' | 'REJECT' | etc
    severidade      varchar(15)  NOT NULL DEFAULT 'INFO',  -- INFO | AVISO | ALERTA | CRITICO
    -- Quem
    id_usuario      int REFERENCES tab_intranet_usr(id) ON DELETE SET NULL,
    usuario_email   varchar(120),                   -- snapshot pra log persistir mesmo se user for deletado
    usuario_nome    varchar(120),
    ip              varchar(45),                    -- IPv6 cabe
    user_agent      text,
    -- O que
    entidade        varchar(60),                    -- 'cliente_cobranca', 'permissao_user', 'sc_aprovacao' etc
    entidade_id     varchar(80),                    -- id ou chave do recurso afetado
    descricao       text NOT NULL,                  -- mensagem legivel
    -- Diff opcional (JSONB pra busca eficiente em campos)
    antes           jsonb,
    depois          jsonb,
    meta            jsonb,                          -- campos extras (ex: numero pedido, valor, etc)
    -- Quando
    criado_em       timestamp NOT NULL DEFAULT NOW()
);

-- Indices pros filtros mais comuns
CREATE INDEX IF NOT EXISTS idx_aud_data       ON tab_auditoria (criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_aud_user       ON tab_auditoria (id_usuario, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_aud_modulo     ON tab_auditoria (modulo, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_aud_severidade ON tab_auditoria (severidade, criado_em DESC) WHERE severidade <> 'INFO';
CREATE INDEX IF NOT EXISTS idx_aud_acao       ON tab_auditoria (acao);
CREATE INDEX IF NOT EXISTS idx_aud_entidade   ON tab_auditoria (entidade, entidade_id);
-- Busca textual (pra grep livre) — depende de pg_trgm acima
CREATE INDEX IF NOT EXISTS idx_aud_descricao_trgm ON tab_auditoria USING gin (descricao gin_trgm_ops);

-- Permissao 1032
INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo) VALUES
  (1032, 'Tecnologia - Auditoria (logs)', 'Tecnologia')
ON CONFLICT (id_permissao) DO UPDATE
   SET nome = EXCLUDED.nome, modulo = EXCLUDED.modulo;
