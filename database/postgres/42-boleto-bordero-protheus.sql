-- Onda 2 do Envio de Boleto: integracao REST com Protheus pra gerar bordero
-- automaticamente. Estende tab_boleto_envio_lote pra registrar o resultado
-- da chamada (numero do bordero, contadores, JSON completo da resposta).
--
-- O lote eh criado em status CRIADO. Ao chamar POST /cobranca/bordero-enviar/:id
-- vira ENVIADO_PROTHEUS (sucesso) ou ERRO_PROTHEUS (falha geral). Se forem
-- rejeicoes parciais (qt_rejeitados > 0 mas qt_processados > 0), continua
-- ENVIADO_PROTHEUS — o operador vê o detalhe na resposta.

ALTER TABLE tab_boleto_envio_lote
    ADD COLUMN IF NOT EXISTS lote_protheus       varchar(20),
    ADD COLUMN IF NOT EXISTS enviado_em          timestamp,
    ADD COLUMN IF NOT EXISTS enviado_por_email   varchar(150),
    ADD COLUMN IF NOT EXISTS qt_processados      int,
    ADD COLUMN IF NOT EXISTS qt_rejeitados       int,
    ADD COLUMN IF NOT EXISTS protheus_resposta   jsonb;

CREATE INDEX IF NOT EXISTS ix_boleto_lote_protheus
    ON tab_boleto_envio_lote (lote_protheus)
 WHERE lote_protheus IS NOT NULL;

COMMENT ON COLUMN tab_boleto_envio_lote.lote_protheus IS
    'Numero do bordero retornado pelo Protheus (campo lote do response). NULL ate o envio acontecer.';
COMMENT ON COLUMN tab_boleto_envio_lote.protheus_resposta IS
    'Response JSON completo do POST /rest/Cobranca/gerar-bordero pra auditoria.';
