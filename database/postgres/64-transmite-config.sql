-- Token do TOTVS Transmite gerenciável pela intranet (sem editar .env/SSH).
-- 1 única linha (id=1). O adapter services/transmite.js lê daqui (fallback .env).
CREATE TABLE IF NOT EXISTS tab_transmite_config (
  id              int PRIMARY KEY DEFAULT 1,
  token           text,
  expira_em       timestamptz,
  alertado_em     timestamptz,
  atualizado_por  varchar(160),
  atualizado_em   timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT transmite_one_row CHECK (id = 1)
);
