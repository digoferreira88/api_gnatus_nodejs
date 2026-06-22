-- Webhook EyeMobile: registra cada transação (venda) recebida, p/ dedupe
-- (evita e-mail duplicado em reenvios) e auditoria do payload.
CREATE TABLE IF NOT EXISTS tab_eyemobile_wh (
  id_transacao   varchar(80) PRIMARY KEY,
  recebido_em    timestamptz NOT NULL DEFAULT NOW(),
  total          numeric(14,2),
  cancelada      boolean     NOT NULL DEFAULT false,
  email_enviado  boolean     NOT NULL DEFAULT false,
  email_erro     text,
  payload        jsonb
);
