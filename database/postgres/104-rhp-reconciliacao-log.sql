-- Log do robô de reconciliação do link do PDF no pipe RHP (304059336).
-- Ver services/rhpReconciliar.js. resultado: CORRIGIDO | SIMULADO | AUSENTE
-- (PDF ainda não está na pasta) | SEM_OP_SERIE | ERRO.
-- A lista de AUSENTE é o relatório dos PDFs que a produção precisa gerar/subir.

CREATE TABLE IF NOT EXISTS tab_rhp_reconciliacao_log (
    id          bigserial   PRIMARY KEY,
    card_id     varchar(30) NOT NULL,
    op          varchar(20),
    serie       varchar(20),
    arquivo     varchar(60),
    resultado   varchar(20) NOT NULL,
    detalhe     text,
    origem      varchar(12) NOT NULL DEFAULT 'CRON',
    criado_em   timestamp   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_rhp_recon_criado   ON tab_rhp_reconciliacao_log (criado_em);
CREATE INDEX IF NOT EXISTS ix_rhp_recon_resultado ON tab_rhp_reconciliacao_log (resultado);
CREATE INDEX IF NOT EXISTS ix_rhp_recon_card      ON tab_rhp_reconciliacao_log (card_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON tab_rhp_reconciliacao_log TO intranet;
GRANT USAGE, SELECT ON SEQUENCE tab_rhp_reconciliacao_log_id_seq TO intranet;

COMMENT ON TABLE tab_rhp_reconciliacao_log IS
  'Log do robô RHP que conserta o link do PDF que o Zap externo deixou como "Erro no upload" (corrida de tempo). AUSENTE = PDF não gerado pela produção.';
