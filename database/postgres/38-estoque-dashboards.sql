-- Controladoria - Dashboards de Estoque (Valor / Qualidade / Tendencia)
-- Adiciona 1 permissao unica + 2 tabelas auxiliares:
--   tab_estoque_snapshot_mensal  -> cache mensal pra evitar bater Protheus em
--                                   queries pesadas (12 meses, ABC, sem giro).
--                                   Populado por cron diario 03:00.
--   tab_estoque_parametros       -> lead time / nivel de servico / janela de
--                                   demanda. Default global; pode-se sobrescrever
--                                   por tipo de produto via UPSERT.
--
-- O snapshot guarda 1 linha por (ano_mes, cod_produto, armazem). Meses passados
-- ficam imutaveis depois do dia 5 do mes seguinte. Mes corrente eh atualizado
-- diariamente.

INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo) VALUES
  (11004, 'Controladoria - Estoque (Dashboards)', 'Controladoria')
ON CONFLICT (id_permissao) DO NOTHING;

-- Atribui automaticamente ao admin (usuario id=1) caso nao tenha
INSERT INTO tab_intranet_usr_permissoes (id_user, id_permissao)
SELECT 1, 11004
 WHERE EXISTS (SELECT 1 FROM tab_intranet_usr WHERE id = 1)
   AND NOT EXISTS (
     SELECT 1 FROM tab_intranet_usr_permissoes
      WHERE id_user = 1 AND id_permissao = 11004
   );

CREATE TABLE IF NOT EXISTS tab_estoque_snapshot_mensal (
    id              SERIAL PRIMARY KEY,
    ano_mes         varchar(6) NOT NULL,                -- 'YYYYMM'
    cod_produto     varchar(15) NOT NULL,
    armazem         varchar(2)  NOT NULL,
    tipo_produto    varchar(5),                         -- B1_TIPO
    descricao       varchar(120),
    grupo           varchar(10),                        -- B1_GRUPO
    qtd_estoque     numeric(15,4) DEFAULT 0,
    custo_medio     numeric(15,5) DEFAULT 0,            -- B2_CM1
    valor_estoque   numeric(15,2) DEFAULT 0,
    qtd_saidas_mes  numeric(15,4) DEFAULT 0,            -- vendas SD2 + consumo SD3 do mes
    valor_saidas_mes numeric(15,2) DEFAULT 0,           -- (qtd * custo medio)
    snapshot_em     timestamp NOT NULL DEFAULT NOW(),
    UNIQUE (ano_mes, cod_produto, armazem)
);
CREATE INDEX IF NOT EXISTS ix_est_snap_anomes  ON tab_estoque_snapshot_mensal (ano_mes);
CREATE INDEX IF NOT EXISTS ix_est_snap_tipo    ON tab_estoque_snapshot_mensal (tipo_produto);
CREATE INDEX IF NOT EXISTS ix_est_snap_arm     ON tab_estoque_snapshot_mensal (armazem);
CREATE INDEX IF NOT EXISTS ix_est_snap_produto ON tab_estoque_snapshot_mensal (cod_produto);

CREATE TABLE IF NOT EXISTS tab_estoque_parametros (
    id                    SERIAL PRIMARY KEY,
    tipo_produto          varchar(5),                   -- NULL = padrao global
    lead_time_dias        int NOT NULL DEFAULT 30,      -- fallback quando B1_PE = 0
    nivel_servico         numeric(4,2) NOT NULL DEFAULT 1.65,  -- 1.65 = 95%
    janela_demanda_meses  int NOT NULL DEFAULT 6,
    atualizado_em         timestamp NOT NULL DEFAULT NOW(),
    UNIQUE (tipo_produto)
);
INSERT INTO tab_estoque_parametros (tipo_produto, lead_time_dias, nivel_servico, janela_demanda_meses)
VALUES (NULL, 30, 1.65, 6)
ON CONFLICT (tipo_produto) DO NOTHING;

COMMENT ON TABLE tab_estoque_snapshot_mensal IS
    'Cache mensal de saldo + saidas por produto e armazem. Populado por cron diario.';
COMMENT ON TABLE tab_estoque_parametros IS
    'Parametros de calculo de qualidade de estoque (lead time, nivel de servico, janela). NULL em tipo_produto = padrao global.';

-- Grants pro usuario do API (role "intranet"). Idempotente — pode rodar
-- multiplas vezes sem efeito colateral.
GRANT SELECT, INSERT, UPDATE, DELETE ON tab_estoque_snapshot_mensal TO intranet;
GRANT SELECT, INSERT, UPDATE, DELETE ON tab_estoque_parametros      TO intranet;
GRANT USAGE, SELECT ON SEQUENCE tab_estoque_snapshot_mensal_id_seq TO intranet;
GRANT USAGE, SELECT ON SEQUENCE tab_estoque_parametros_id_seq      TO intranet;
