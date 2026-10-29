-- Lista de presença dos treinamentos: o professor/Educacional marca quem compareceu
-- na aba Participantes (checkbox antes do nome) e a presença sai no Excel exportado.
-- Fica na própria inscrição (1 inscrição ativa = 1 pessoa numa sessão).
-- presenca_em / presenca_por = última vez que alguém marcou ou desmarcou.

ALTER TABLE tab_treina_inscricao
  ADD COLUMN IF NOT EXISTS presente     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS presenca_em  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS presenca_por INTEGER;   -- tab_intranet_usr.id
