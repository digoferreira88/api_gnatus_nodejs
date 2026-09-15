-- Treinamentos: (A) reunião Teams gerada no calendário do organizador (educacional@)
-- guardando o id do evento p/ atualizar/cancelar; (B) lista de convidados por e-mail.

ALTER TABLE tab_treina_sessao ADD COLUMN IF NOT EXISTS educacional_event_id varchar(300);

CREATE TABLE IF NOT EXISTS tab_treina_convite (
  id             SERIAL PRIMARY KEY,
  treinamento_id INTEGER NOT NULL REFERENCES tab_treina_treinamento(id) ON DELETE CASCADE,
  email          VARCHAR(200) NOT NULL,
  nome           VARCHAR(200),
  convidado_por  INTEGER,
  convidado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reenviado_em   TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_treina_convite ON tab_treina_convite (treinamento_id, lower(email));

GRANT SELECT, INSERT, UPDATE, DELETE ON tab_treina_convite TO intranet;
GRANT USAGE, SELECT ON SEQUENCE tab_treina_convite_id_seq TO intranet;
