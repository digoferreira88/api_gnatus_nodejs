-- 46-producao-gestao.sql
-- Submodulo de Gestao da Producao (perm 14002).
-- Adiciona log de transicoes de status nas etapas pra calcular tempos
-- (entre "em_andamento" e "aprovado/reprovado") e produtividade por
-- colaborador.
--
-- O log e populado pelo endpoint etapa-update sempre que o status muda.
-- Etapas existentes nao geram historico retroativo — comeca limpo.

CREATE TABLE IF NOT EXISTS tab_prod_registro_etapa_log (
    id                 SERIAL PRIMARY KEY,
    registro_etapa_id  int  NOT NULL REFERENCES tab_prod_registro_etapa(id) ON DELETE CASCADE,
    registro_id        int  NOT NULL REFERENCES tab_prod_registro(id) ON DELETE CASCADE,
    etapa_codigo       smallint NOT NULL,
    status_de          varchar(20),                    -- NULL no primeiro evento
    status_para        varchar(20) NOT NULL,
    responsavel_id     int  REFERENCES tab_intranet_usr(id) ON DELETE SET NULL,  -- responsavel da etapa no momento
    mudou_por          int  REFERENCES tab_intranet_usr(id) ON DELETE SET NULL,  -- quem disparou a mudanca
    mudou_em           timestamp NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_prod_etapa_log_reg     ON tab_prod_registro_etapa_log (registro_id, etapa_codigo);
CREATE INDEX IF NOT EXISTS ix_prod_etapa_log_resp    ON tab_prod_registro_etapa_log (responsavel_id, mudou_em DESC);
CREATE INDEX IF NOT EXISTS ix_prod_etapa_log_status  ON tab_prod_registro_etapa_log (status_para, mudou_em DESC);
CREATE INDEX IF NOT EXISTS ix_prod_etapa_log_periodo ON tab_prod_registro_etapa_log (mudou_em DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON tab_prod_registro_etapa_log TO intranet;
GRANT USAGE, SELECT ON SEQUENCE tab_prod_registro_etapa_log_id_seq TO intranet;

-- Permissao 14002 ja existe (Producao - Admin) e cobre o submodulo de gestao.
-- Nao precisa nova perm.
