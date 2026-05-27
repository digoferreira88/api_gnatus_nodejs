-- DRE > Centro de Custo — orcamento anual cadastrado pelo usuario.
--
-- Granularidade ANUAL: um valor por (cc, ano). O frontend distribui linearmente
-- por 12 quando precisa de previsto mensal (sazonalidade nao modelada agora —
-- migrar pra mensal real depois, mantendo este modelo como fonte historica).
--
-- Indicadores derivados (no backend/frontend):
--   - Realizado / Orcado = % executado YTD
--   - Saldo restante = orcado - realizado
--   - Tendencia anual = realizado_ate_mes * 12 / mes_corrente (projecao linear)
--
-- O campo cc_descricao eh snapshot do nome do CC no momento do cadastro — a
-- fonte da verdade da descricao continua sendo CTT010 (Protheus), mas guardar
-- aqui evita join no momento da consulta dos indicadores.

CREATE TABLE IF NOT EXISTS tab_centro_custo_orcamento (
    id              SERIAL PRIMARY KEY,
    cc_codigo       varchar(20) NOT NULL,
    cc_descricao    varchar(120),
    ano             int NOT NULL,
    valor_orcado    numeric(15, 2) NOT NULL DEFAULT 0,
    obs             text,
    criado_por      int REFERENCES tab_intranet_usr(id) ON DELETE SET NULL,
    atualizado_por  int REFERENCES tab_intranet_usr(id) ON DELETE SET NULL,
    criado_em       timestamp NOT NULL DEFAULT NOW(),
    atualizado_em   timestamp NOT NULL DEFAULT NOW(),
    UNIQUE (cc_codigo, ano)
);

CREATE INDEX IF NOT EXISTS ix_cc_orcamento_ano ON tab_centro_custo_orcamento (ano);
CREATE INDEX IF NOT EXISTS ix_cc_orcamento_cc  ON tab_centro_custo_orcamento (cc_codigo);
