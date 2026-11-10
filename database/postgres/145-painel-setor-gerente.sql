-- Painel de Gestão à Vista: vínculo Setor × Gerente (10/11/2026).
-- Aplicar como postgres (GRANT no fim). Idempotente.
--
-- Quem lidera cada setor do painel. Base do aviso ao gerente sobre os cards
-- atrasados em que os liderados dele são responsáveis (liderado = responsável
-- do Pipefy vinculado ao setor em tab_painel_usuario_setor).
--
-- Gerente = usuário da intranet (tab_intranet_usr): o e-mail do aviso vem de lá.
-- Muitos-para-muitos: um setor pode ter mais de um gerente (gerente + coordenador)
-- e um gerente pode responder por vários setores (ex.: comercial atacado + varejo).

CREATE TABLE IF NOT EXISTS tab_painel_setor_gerente (
  setor_id   INTEGER NOT NULL REFERENCES tab_painel_setor(id) ON DELETE CASCADE,
  id_user    INTEGER NOT NULL REFERENCES tab_intranet_usr(id) ON DELETE CASCADE,
  criado_por VARCHAR(120),
  criado_em  TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (setor_id, id_user)
);
CREATE INDEX IF NOT EXISTS ix_painel_setor_gerente_user ON tab_painel_setor_gerente (id_user);

GRANT SELECT, INSERT, UPDATE, DELETE ON tab_painel_setor_gerente TO intranet;
