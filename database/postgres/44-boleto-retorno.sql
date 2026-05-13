-- Onda 3 do Envio de Boleto: ler retorno do banco via consulta SE1.
--
-- Operador roda FINA130/140 no Protheus pra processar o arquivo de retorno
-- (.RET) do banco. Isso atualiza E1_OCORREN, E1_NUMBOR, E1_NUMBCO, E1_BAIXA
-- nos titulos da SE1.
--
-- A Intranet apenas CONSULTA esses campos via POST /financeiro/boleto-lote/:id/sincronizar
-- e popula esta tabela com 1 row por titulo do lote. Nao parseia CNAB.

CREATE TABLE IF NOT EXISTS tab_boleto_envio_lote_retorno (
    id                SERIAL PRIMARY KEY,
    id_lote           int NOT NULL REFERENCES tab_boleto_envio_lote(id) ON DELETE CASCADE,
    -- Chave do titulo na SE1
    prefixo           varchar(10),
    numero            varchar(20) NOT NULL,
    parcela           varchar(5),
    cliente_cod       varchar(10) NOT NULL,
    cliente_loja      varchar(5)  NOT NULL,
    -- Status calculado pela Intranet a partir de E1_OCORREN:
    -- PENDENTE  : nao foi registrado ainda (sem retorno do banco no Protheus)
    -- REGISTRADO: banco confirmou registro (boleto pronto pra cobrar)
    -- LIQUIDADO : cliente pagou (E1_BAIXA preenchido)
    -- BAIXADO   : baixa manual (nao por liquidacao do banco)
    -- REJEITADO : banco rejeitou registro (precisa correcao)
    -- DESCONHECIDO: ocorrencia nao mapeada — operador investiga manualmente
    status_banco      varchar(20) NOT NULL DEFAULT 'PENDENTE',
    -- Codigo bruto do Protheus (E1_OCORREN) + descricao mapeada
    ocorrencia_cod    varchar(10),
    ocorrencia_desc   varchar(120),
    -- Identificadores do banco
    nosso_numero      varchar(20),                  -- E1_NUMBCO (numero atribuido pelo banco)
    bordero_protheus  varchar(20),                  -- E1_NUMBOR (numero do bordero no Protheus)
    -- Liquidacao
    valor_liquidado   numeric(14,2),                -- E1_VALLIQ
    data_liquidacao   varchar(8),                   -- E1_BAIXA (YYYYMMDD)
    -- Disparo (Onda 3.4-3.6)
    disparado_em      timestamp,
    canais_disparo    varchar(40),                  -- ex: 'WHATSAPP,EMAIL'
    -- Sincronizacao
    sincronizado_em   timestamp NOT NULL DEFAULT NOW(),
    UNIQUE (id_lote, prefixo, numero, parcela, cliente_cod, cliente_loja)
);
CREATE INDEX IF NOT EXISTS ix_blt_ret_lote   ON tab_boleto_envio_lote_retorno (id_lote);
CREATE INDEX IF NOT EXISTS ix_blt_ret_status ON tab_boleto_envio_lote_retorno (status_banco);

GRANT SELECT, INSERT, UPDATE, DELETE ON tab_boleto_envio_lote_retorno TO intranet;
GRANT USAGE, SELECT ON SEQUENCE tab_boleto_envio_lote_retorno_id_seq TO intranet;

-- Adiciona campos novos no lote pra rastrear o ciclo completo
ALTER TABLE tab_boleto_envio_lote
    ADD COLUMN IF NOT EXISTS sincronizado_em       timestamp,
    ADD COLUMN IF NOT EXISTS qt_registrados        int,
    ADD COLUMN IF NOT EXISTS qt_liquidados         int,
    ADD COLUMN IF NOT EXISTS qt_rejeitados_banco   int,
    ADD COLUMN IF NOT EXISTS qt_pendentes_banco    int;

COMMENT ON TABLE tab_boleto_envio_lote_retorno IS
    'Status de cada titulo do lote apos retorno do banco. Atualizado por POST /financeiro/boleto-lote/:id/sincronizar (consulta SE1).';
