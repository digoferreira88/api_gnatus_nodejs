-- Cache leve de metadados do produto: lead time real (B1_PE), unidade etc.
-- Atualizado pelo mesmo cron diario de estoque, evita bater Protheus em
-- toda chamada do dashboard de qualidade.

CREATE TABLE IF NOT EXISTS tab_estoque_produto_meta (
    cod_produto      varchar(15) PRIMARY KEY,
    tipo_produto     varchar(5),
    descricao        varchar(120),
    grupo            varchar(10),
    unidade          varchar(3),
    lead_time_dias   int NOT NULL DEFAULT 0,    -- B1_PE
    atualizado_em    timestamp NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_est_pmeta_tipo ON tab_estoque_produto_meta (tipo_produto);

GRANT SELECT, INSERT, UPDATE, DELETE ON tab_estoque_produto_meta TO intranet;

COMMENT ON TABLE tab_estoque_produto_meta IS
    'Cache de metadados B1 (lead time / unidade / tipo) pra evitar bater Protheus em queries do dashboard. Refresh diario pelo cron de snapshot.';
