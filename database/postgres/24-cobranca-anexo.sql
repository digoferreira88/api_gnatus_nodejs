-- Anexos por cliente no modulo de Cobranca.
-- Armazenamento fisico: disco da VPS em UPLOAD_DIR/cobranca/<cod>_<loja>/<filename>.
-- Apenas o caminho relativo + metadata fica no banco. Download autenticado.

CREATE TABLE IF NOT EXISTS tab_cobranca_anexo (
    id                      SERIAL PRIMARY KEY,
    cliente_cod             varchar(10) NOT NULL,
    cliente_loja            varchar(4)  NOT NULL,
    titulo                  varchar(200) NOT NULL,
    arquivo_path            varchar(600) NOT NULL,    -- relativo ao UPLOAD_DIR (ex: cobranca/000123_01/1714723000-acordo.pdf)
    arquivo_nome_original   varchar(300) NOT NULL,
    arquivo_tamanho         bigint NOT NULL,           -- bytes
    arquivo_mime            varchar(100),
    enviado_por             int REFERENCES tab_intranet_usr(id) ON DELETE SET NULL,
    enviado_em              timestamp NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_cob_anexo_cliente ON tab_cobranca_anexo (cliente_cod, cliente_loja, enviado_em DESC);
