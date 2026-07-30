-- Webhooks do Pipefy processados NA intranet (substitui o webhook_gnatus.php
-- da vm-pipefy, quebrado desde 24/04). Idempotente.

-- Log de todo evento recebido (auditoria/diagnostico)
CREATE TABLE IF NOT EXISTS tab_pipefy_wh_evento (
  id          SERIAL PRIMARY KEY,
  action      TEXT,
  card_id     TEXT,
  pipe_id     TEXT,
  fase_id     TEXT,
  fase_nome   TEXT,
  payload     JSONB,
  processado  BOOLEAN NOT NULL DEFAULT FALSE,
  resultado   TEXT,
  recebido_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_pipefy_wh_evento_em ON tab_pipefy_wh_evento (recebido_em DESC);

-- Fila de WhatsApp (mesma semantica do fila_whatsapp do PHP: dedupe por
-- numero+card+fase+acao; enviado '' pendente / 'P' reivindicada-processando /
-- '1' ok / '0' falha). 'P' é escrita atomicamente pelo drain (processarFila)
-- para reivindicar a linha antes de enviar — impede que dois drains sobrepostos
-- reenviem a mesma mensagem; 'P' órfã (drain morreu) é reprocessada após 2 min.
CREATE TABLE IF NOT EXISTS tab_pipefy_wh_fila (
  id              SERIAL PRIMARY KEY,
  numero_telefone TEXT NOT NULL,
  card_id         TEXT NOT NULL,
  fase_id         TEXT,
  card_action     TEXT,
  template_id     TEXT,
  parametros      TEXT,
  enviado         TEXT NOT NULL DEFAULT '',
  resposta        TEXT,
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  enviado_em      TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pipefy_wh_fila_dedup
  ON tab_pipefy_wh_fila (numero_telefone, card_id, COALESCE(fase_id,''), COALESCE(card_action,''));
