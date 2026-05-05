-- Cobranca WhatsApp: log de envios + flag de automacao on/off.
--
-- Disparos automaticos via cron diario (services/scheduler.js):
--   D-1 = lembrete vencimento amanha
--   D0  = vencimento hoje
--   D+3 = atraso 3 dias sem pagamento
--
-- Idempotencia: UNIQUE garante 1 envio por (titulo + tipo + dia).

CREATE TABLE IF NOT EXISTS tab_cobranca_whatsapp_envio (
    id              SERIAL PRIMARY KEY,
    -- titulo (chave composta SE1)
    filial          varchar(4)   NOT NULL,
    prefixo         varchar(3)   NOT NULL,
    numero          varchar(15)  NOT NULL,
    parcela         varchar(3)   NOT NULL DEFAULT '',
    -- cliente
    cliente_cod     varchar(10)  NOT NULL,
    cliente_loja    varchar(4)   NOT NULL,
    cliente_nome    varchar(200),
    -- envio
    tipo            varchar(4)   NOT NULL,  -- 'D-1' | 'D0' | 'D+3'
    telefone        varchar(20),             -- 55DDDNUMERO ou null se nao tinha
    template_nome   varchar(80),
    template_id     varchar(80),
    parametros      jsonb,
    valor_titulo    numeric(14,2),
    vencimento      date,
    -- resultado
    status          varchar(20)  NOT NULL,   -- 'OK' | 'ERRO' | 'SEM_TELEFONE' | 'SKIP'
    wamid           varchar(120),            -- WhatsApp Message ID retornado pelo SURI
    erro            text,
    response_json   jsonb,
    -- meta
    criado_em       timestamp NOT NULL DEFAULT NOW(),
    disparo_em      date NOT NULL DEFAULT CURRENT_DATE
);

-- Idempotencia: evita reenvio do mesmo tipo no mesmo dia pro mesmo titulo
CREATE UNIQUE INDEX IF NOT EXISTS ux_cob_wpp_idem
  ON tab_cobranca_whatsapp_envio (filial, prefixo, numero, parcela, cliente_cod, cliente_loja, tipo, disparo_em);

-- Indices pra dashboard
CREATE INDEX IF NOT EXISTS ix_cob_wpp_data   ON tab_cobranca_whatsapp_envio (criado_em DESC);
CREATE INDEX IF NOT EXISTS ix_cob_wpp_status ON tab_cobranca_whatsapp_envio (status, criado_em DESC);
CREATE INDEX IF NOT EXISTS ix_cob_wpp_cli    ON tab_cobranca_whatsapp_envio (cliente_cod, cliente_loja);

-- Configuracao key/value (1 row por chave) — ligar/desligar automacao + futuras flags
CREATE TABLE IF NOT EXISTS tab_cobranca_whatsapp_config (
    chave          varchar(50)  PRIMARY KEY,
    valor          varchar(500),
    atualizado_por int REFERENCES tab_intranet_usr(id) ON DELETE SET NULL,
    atualizado_em  timestamp NOT NULL DEFAULT NOW()
);

-- Flag inicial: automacao DESLIGADA por padrao (precisa ligar manualmente)
INSERT INTO tab_cobranca_whatsapp_config (chave, valor) VALUES
  ('automacao_ativa', 'false')
ON CONFLICT (chave) DO NOTHING;
