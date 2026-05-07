-- Tecnologia - Gestao de Linhas Moveis Corporativas
-- Substitui a planilha "Gnatus_Linhas_Telefonia Movel.xlsx" (abas Claro/Tim).
-- Estrutura:
--   tab_operadora                operadoras (Claro/Tim/Vivo)
--   tab_telefonia_conta          1 conta de operadora = 1 row (a planilha tem ate 5 contas/aba)
--   tab_telefonia_departamento   tabela de dominio (alimentada da planilha)
--   tab_telefonia_linha          o ativo principal: 1 numero telefonico
--   tab_telefonia_linha_hist     historico de troca de usuario / mudanca de plano

CREATE TABLE IF NOT EXISTS tab_operadora (
    id      SERIAL PRIMARY KEY,
    nome    varchar(40) NOT NULL UNIQUE,
    ativo   boolean NOT NULL DEFAULT true
);

INSERT INTO tab_operadora (nome) VALUES ('Claro'), ('Tim'), ('Vivo')
ON CONFLICT (nome) DO NOTHING;

CREATE TABLE IF NOT EXISTS tab_telefonia_conta (
    id              SERIAL PRIMARY KEY,
    id_operadora    int NOT NULL REFERENCES tab_operadora(id) ON DELETE RESTRICT,
    numero_conta    varchar(40) NOT NULL,
    numero_cliente  varchar(40),
    razao_social    varchar(160),
    UNIQUE (id_operadora, numero_conta)
);

CREATE TABLE IF NOT EXISTS tab_telefonia_departamento (
    id      SERIAL PRIMARY KEY,
    nome    varchar(80) NOT NULL UNIQUE,
    ativo   boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS tab_telefonia_linha (
    id              SERIAL PRIMARY KEY,
    id_operadora    int NOT NULL REFERENCES tab_operadora(id) ON DELETE RESTRICT,
    id_conta        int REFERENCES tab_telefonia_conta(id) ON DELETE SET NULL,
    id_departamento int REFERENCES tab_telefonia_departamento(id) ON DELETE SET NULL,
    numero_telefone varchar(20)  NOT NULL,
    plano           varchar(120),
    franquia_gb     numeric(8,2),
    pessoa          varchar(120),               -- texto livre (pode ter autocomplete via SRA Protheus)
    codigo_protheus varchar(20),                -- opcional: SRA_MAT do colaborador
    filial          varchar(40),                -- opcional, ex "Franquia Fortaleza"
    centro_custo    varchar(20),
    data_ativacao   date,
    data_vencimento date,                       -- vencimento do contrato/plano
    status          varchar(15)  NOT NULL DEFAULT 'Ativa',  -- Ativa | Suspensa | Cancelada | EmEstoque
    observacoes     text,
    criado_em       timestamp NOT NULL DEFAULT NOW(),
    atualizado_em   timestamp NOT NULL DEFAULT NOW(),
    UNIQUE (id_operadora, numero_telefone)
);
CREATE INDEX IF NOT EXISTS ix_tel_linha_status ON tab_telefonia_linha (status);
CREATE INDEX IF NOT EXISTS ix_tel_linha_pessoa ON tab_telefonia_linha (pessoa);
CREATE INDEX IF NOT EXISTS ix_tel_linha_dept   ON tab_telefonia_linha (id_departamento);
CREATE INDEX IF NOT EXISTS ix_tel_linha_venc   ON tab_telefonia_linha (data_vencimento);

CREATE TABLE IF NOT EXISTS tab_telefonia_linha_hist (
    id          BIGSERIAL PRIMARY KEY,
    id_linha    int NOT NULL REFERENCES tab_telefonia_linha(id) ON DELETE CASCADE,
    acao        varchar(20) NOT NULL,           -- CREATE | UPDATE | TROCA_USUARIO | STATUS | DELETE | IMPORT
    antes       jsonb,
    depois      jsonb,
    id_usuario  int REFERENCES tab_intranet_usr(id) ON DELETE SET NULL,
    usuario_nome varchar(120),
    descricao   text,
    criado_em   timestamp NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_tel_hist_linha ON tab_telefonia_linha_hist (id_linha, criado_em DESC);

-- Reusa permissao 1027 (Tecnologia - Termo + Equipamentos), nao cria perm nova.
