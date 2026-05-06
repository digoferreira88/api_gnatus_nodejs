-- Tecnologia - Importacao Protheus (TRPWSIMP)
-- Pagina pra importar dados em massa via endpoints REST do Template TOTVS
-- (clientes, produtos, fornecedores, pedidos, etc — 47+ IDs).
-- Operador informa credenciais Protheus a cada execucao (sem persistir).

-- Perm 1031
INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo) VALUES
  (1031, 'Tecnologia - Importação Protheus (TRPWSIMP)', 'Tecnologia')
ON CONFLICT (id_permissao) DO UPDATE
   SET nome = EXCLUDED.nome, modulo = EXCLUDED.modulo;

-- Log historico de execucoes (pra auditoria e re-execucao posterior)
CREATE TABLE IF NOT EXISTS tab_protheus_import_log (
    id              SERIAL PRIMARY KEY,
    -- Operacao
    modelo_id       int NOT NULL,                  -- ID TRPWSIMP (1..99)
    modelo_nome     varchar(100),                  -- ex: '02 - Clientes'
    tabela_destino  varchar(10),                   -- preenchido quando ID=99
    empresa         varchar(4),
    filial          varchar(8),
    protheus_user   varchar(50),                   -- usuario Protheus (nao a senha)
    -- Resultado
    sucesso         boolean,
    qt_total        int DEFAULT 0,
    qt_atualizados  int DEFAULT 0,
    qt_inconsistencias int DEFAULT 0,
    duracao         varchar(20),                   -- "00:00:08" do TRPWSIMP
    -- Payload e resposta (JSONB pra debug/repostagem)
    request_body    jsonb,
    response_body   jsonb,
    erro            text,
    -- Meta
    executado_por   int REFERENCES tab_intranet_usr(id) ON DELETE SET NULL,
    executado_em    timestamp NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pti_log_user  ON tab_protheus_import_log (executado_por, executado_em DESC);
CREATE INDEX IF NOT EXISTS idx_pti_log_data  ON tab_protheus_import_log (executado_em DESC);
CREATE INDEX IF NOT EXISTS idx_pti_log_modelo ON tab_protheus_import_log (modelo_id);
