-- 117 — Status de cobrança POR TÍTULO.
-- O status de cobrança era só do cliente (tab_cobranca_status_cliente). Alguns
-- clientes têm títulos em situações diferentes (um em Confissão de Dívida, outro
-- em Protesto, outro só Em cobrança). Esta tabela guarda o status de cada título
-- para refletir o andamento real; onde o título não tem status próprio, a tela
-- herda o status do cliente. Mesmos valores de status (services/cobrancaStatus.js).

CREATE TABLE IF NOT EXISTS tab_cobranca_status_titulo (
    cliente_cod      varchar(10) NOT NULL,
    cliente_loja     varchar(4)  NOT NULL,
    titulo_prefixo   varchar(10) NOT NULL DEFAULT '',
    titulo_num       varchar(20) NOT NULL DEFAULT '',
    titulo_parcela   varchar(4)  NOT NULL DEFAULT '',
    titulo_tipo      varchar(6)  NOT NULL DEFAULT '',
    status           varchar(20) NOT NULL,
    observacao       varchar(500),
    dt_atualizacao   timestamp   NOT NULL DEFAULT NOW(),
    id_user          int         NOT NULL REFERENCES tab_intranet_usr(id),
    PRIMARY KEY (cliente_cod, cliente_loja, titulo_prefixo, titulo_num, titulo_parcela, titulo_tipo)
);
CREATE INDEX IF NOT EXISTS ix_cobr_stt_cliente ON tab_cobranca_status_titulo (cliente_cod, cliente_loja);
