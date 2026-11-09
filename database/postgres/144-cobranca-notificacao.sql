-- 144 — Cobrança: notificação formal ao cliente (protesto; Serasa depois)
-- por e-mail (cobranca@) e WhatsApp (template Suri). Tela /cobranca/notificacoes.
--
-- Uma linha por TÍTULO × CANAL × envio. O e-mail é um por cliente, mas grava
-- uma linha para cada título que ele cobre (mesmo envio_id).
--
-- Trava de duplicidade: índice único PARCIAL em (tipo, canal, dia, título)
-- só para status ENVIANDO/OK. A reserva (ENVIANDO) é gravada antes de mandar;
-- se falhar vira ERRO e libera nova tentativa no mesmo dia.
--
-- Idempotente. Rodar como postgres:
--   sudo cat /home/intranet/backend/database/postgres/144-cobranca-notificacao.sql | sudo -u postgres psql -d intranet -v ON_ERROR_STOP=1

CREATE TABLE IF NOT EXISTS tab_cobranca_notificacao (
    id             SERIAL PRIMARY KEY,
    tipo           varchar(20)  NOT NULL,              -- 'PROTESTO'
    canal          varchar(10)  NOT NULL,              -- 'EMAIL' | 'WHATSAPP'
    dia            date         NOT NULL,              -- dia do envio (Brasília)
    -- título (chave SE1)
    filial         varchar(4)   NOT NULL DEFAULT '01',
    prefixo        varchar(3)   NOT NULL DEFAULT '',
    numero         varchar(15)  NOT NULL,
    parcela        varchar(3)   NOT NULL DEFAULT '',
    tipo_titulo    varchar(3)   NOT NULL DEFAULT '',
    cliente_cod    varchar(10)  NOT NULL,
    cliente_loja   varchar(4)   NOT NULL,
    cliente_nome   varchar(200),
    -- o que foi comunicado
    valor          numeric(14,2),
    vencimento     date,
    dias_atraso    integer,
    banco          varchar(60),
    destino        varchar(500),                       -- e-mail(s) ou telefone 55DDD...
    parametros     jsonb,                              -- parâmetros do template (WhatsApp)
    -- resultado
    status         varchar(20)  NOT NULL,              -- ENVIANDO | OK | ERRO
    erro           text,
    wamid          varchar(120),
    response_json  jsonb,
    envio_id       varchar(40),                        -- agrupa as linhas de um mesmo disparo
    id_user        integer,
    criado_em      timestamp    NOT NULL DEFAULT NOW(),
    atualizado_em  timestamp
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_cobr_notif_dia
    ON tab_cobranca_notificacao (tipo, canal, dia, filial, prefixo, numero, parcela, tipo_titulo, cliente_cod, cliente_loja)
 WHERE status IN ('ENVIANDO', 'OK');

CREATE INDEX IF NOT EXISTS ix_cobr_notif_titulo
    ON tab_cobranca_notificacao (cliente_cod, cliente_loja, numero, parcela);

CREATE INDEX IF NOT EXISTS ix_cobr_notif_criado
    ON tab_cobranca_notificacao (criado_em DESC);

-- Permissão no catálogo (aparece em Editar Permissões)
INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo)
SELECT 9009, 'Cobrança - Notificação de protesto (envio)', 'Cobrança'
 WHERE NOT EXISTS (SELECT 1 FROM tab_intranet_permissoes WHERE id_permissao = 9009);

-- Concede ao admin (p/ testar de imediato)
INSERT INTO tab_intranet_usr_permissoes (id_user, id_permissao, matricula)
SELECT u.id, 9009, u.matricula FROM tab_intranet_usr u WHERE u.email = 'admin@gnatus.com.br'
ON CONFLICT (id_user, id_permissao) DO NOTHING;

-- GRANTs p/ o role da aplicação (migration roda como postgres)
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE tab_cobranca_notificacao TO intranet;
GRANT USAGE, SELECT ON SEQUENCE tab_cobranca_notificacao_id_seq TO intranet;
