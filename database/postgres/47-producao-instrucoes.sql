-- 47-producao-instrucoes.sql
-- Catalogo central de Instrucoes de Trabalho por (produto, etapa).
-- Substitui o sistema de "database de produtos" do Pipefy.
--
-- Quando uma OP eh aberta, o detalhe do registro consulta as instrucoes
-- pelo produto_codigo e devolve junto — UI mostra dentro do accordion da
-- etapa correspondente. Linkagem dinamica: editar a instrucao impacta
-- todas as OPs (passadas e futuras) imediatamente.
--
-- Storage: SharePoint /sites/Pipefy/Documents/Instrucoes Produto/{codigo}/

CREATE TABLE IF NOT EXISTS tab_prod_instrucao (
    id                   SERIAL PRIMARY KEY,
    produto_codigo       varchar(20) NOT NULL,
    etapa_codigo         smallint,                 -- NULL = instrucao geral do produto
    titulo               varchar(200) NOT NULL,
    sharepoint_drive_id  text NOT NULL,
    sharepoint_item_id   text NOT NULL,
    sharepoint_path      text NOT NULL,
    web_url              text NOT NULL,
    nome_original        varchar(300),
    mime_type            varchar(120),
    tamanho_bytes        bigint,
    criado_por           int REFERENCES tab_intranet_usr(id) ON DELETE SET NULL,
    criado_em            timestamp NOT NULL DEFAULT NOW(),
    atualizado_por       int REFERENCES tab_intranet_usr(id) ON DELETE SET NULL,
    atualizado_em        timestamp NOT NULL DEFAULT NOW()
);

-- 1 instrucao por (produto, etapa) quando etapa esta definida
CREATE UNIQUE INDEX IF NOT EXISTS ux_prod_instr_prod_etapa
  ON tab_prod_instrucao (produto_codigo, etapa_codigo)
  WHERE etapa_codigo IS NOT NULL;

-- 1 instrucao geral por produto (etapa NULL)
CREATE UNIQUE INDEX IF NOT EXISTS ux_prod_instr_prod_geral
  ON tab_prod_instrucao (produto_codigo)
  WHERE etapa_codigo IS NULL;

-- Lookup rapido por produto
CREATE INDEX IF NOT EXISTS ix_prod_instr_prod
  ON tab_prod_instrucao (produto_codigo);

GRANT SELECT, INSERT, UPDATE, DELETE ON tab_prod_instrucao TO intranet;
GRANT USAGE, SELECT ON SEQUENCE tab_prod_instrucao_id_seq TO intranet;
