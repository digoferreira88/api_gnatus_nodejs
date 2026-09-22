-- 118 — Comissao de cobranca (recuperacao de boletos vencidos).
-- Base = valor RECUPERADO (titulo boleto baixado/pago em atraso, mesma definicao da
-- aba "Recuperados": E1_BAIXA no periodo, DATEDIFF(E1_VENCREA,E1_BAIXA)); comissao =
-- valor x % da FAIXA DE ATRASO na data do pagamento. 0-6 dias = 0%. Gestora configura
-- as faixas, as BUs excluidas e quem e o colaborador cobrador. Sobe VAZIO.

-- Config (linha unica id=1): quem e o colaborador cobrador.
CREATE TABLE IF NOT EXISTS tab_cobranca_comissao_config (
    id             int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    colaborador_id int REFERENCES tab_intranet_usr(id),
    atualizado_em  timestamp NOT NULL DEFAULT NOW(),
    id_user        int REFERENCES tab_intranet_usr(id)
);
INSERT INTO tab_cobranca_comissao_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Faixas de atraso -> % de comissao. dias_max NULL = "e acima". Sobe so com 0-6 = 0%.
CREATE TABLE IF NOT EXISTS tab_cobranca_comissao_faixa (
    id        SERIAL PRIMARY KEY,
    dias_min  int NOT NULL,
    dias_max  int,                          -- NULL = sem teto (">= dias_min")
    pct       numeric(7,4) NOT NULL DEFAULT 0,
    ordem     int NOT NULL DEFAULT 0,
    ativo     boolean NOT NULL DEFAULT TRUE
);
INSERT INTO tab_cobranca_comissao_faixa (dias_min, dias_max, pct, ordem)
SELECT 0, 6, 0, 0
 WHERE NOT EXISTS (SELECT 1 FROM tab_cobranca_comissao_faixa);

-- BUs excluidas da base de comissao (por codigo C5_ZTIPO; label so p/ exibir).
CREATE TABLE IF NOT EXISTS tab_cobranca_comissao_bu_excluida (
    bu_codigo  varchar(30) PRIMARY KEY,
    bu_label   varchar(150),
    criado_em  timestamp NOT NULL DEFAULT NOW(),
    id_user    int REFERENCES tab_intranet_usr(id)
);

-- Fechamento mensal (congela o valor apurado p/ o financeiro/RH pagar).
CREATE TABLE IF NOT EXISTS tab_cobranca_comissao_fechamento (
    id              SERIAL PRIMARY KEY,
    ano_mes         varchar(6)  NOT NULL,          -- competencia = mes da baixa (YYYYMM)
    colaborador_id  int REFERENCES tab_intranet_usr(id),
    base_recuperada numeric(18,2) NOT NULL DEFAULT 0,   -- total recuperado (boletos, ja s/ BUs excluidas)
    comissao        numeric(18,2) NOT NULL DEFAULT 0,   -- soma valor x % da faixa
    snapshot        jsonb,                              -- faixas/BUs/detalhe no momento do fechamento
    fechado_por     int REFERENCES tab_intranet_usr(id),
    fechado_em      timestamp NOT NULL DEFAULT NOW(),
    UNIQUE (ano_mes, colaborador_id)
);
