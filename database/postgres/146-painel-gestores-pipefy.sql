-- Painel de Gestão à Vista: gerentes dos setores vêm da database GESTORES do
-- Pipefy (10/11/2026). Aplicar como postgres (GRANT no fim). Idempotente.
--
-- A database GESTORES (id ri_r5xI5) já cadastra nome, e-mail e WhatsApp de cada
-- gestor para os envios de mensagem. Em vez de escolher o gerente entre os
-- usuários da intranet (migration 145), o setor passa a apontar para o registro
-- dessa database.
--
-- tab_painel_gestor        espelho da database (relido a cada leitura agendada
--                          do painel e pelo botão da tela de config). Registro que
--                          some do Pipefy NÃO é apagado: fica no_pipefy = FALSE e o
--                          vínculo continua visível até alguém trocar.
-- tab_painel_setor_gestor  setor -> gestor(es), muitos-para-muitos.
--
-- Os vínculos já feitos na tabela da 145 são copiados pela 147 (casando o
-- e-mail), depois que o espelho tiver sido lido pela primeira vez.

CREATE TABLE IF NOT EXISTS tab_painel_gestor (
  record_id  VARCHAR(20) PRIMARY KEY,          -- id do registro na database GESTORES
  nome       VARCHAR(150) NOT NULL,
  email      VARCHAR(150),                     -- minúsculo
  whatsapp   VARCHAR(20),                      -- só dígitos, com DDI (ex.: 5517999999999)
  no_pipefy  BOOLEAN NOT NULL DEFAULT TRUE,    -- FALSE = sumiu da database
  lido_em    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tab_painel_setor_gestor (
  setor_id   INTEGER NOT NULL REFERENCES tab_painel_setor(id) ON DELETE CASCADE,
  gestor_id  VARCHAR(20) NOT NULL REFERENCES tab_painel_gestor(record_id) ON DELETE CASCADE,
  criado_por VARCHAR(120),
  criado_em  TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (setor_id, gestor_id)
);
CREATE INDEX IF NOT EXISTS ix_painel_setor_gestor_gestor ON tab_painel_setor_gestor (gestor_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON tab_painel_gestor, tab_painel_setor_gestor TO intranet;
