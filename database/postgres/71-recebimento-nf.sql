-- Recebimento de NF de Entrada (conferência CEGA de pré-nota + classificação).
-- Fluxo: pré-nota digitada no Protheus (SF1 com F1_STATUS em branco) -> intranet
-- lista -> almoxarifado confere SEM ver a qtd da NF (cega) -> sistema calcula
-- divergência -> fiscal classifica (TES por item) -> REST custom grava no
-- Protheus (classificação da pré-nota). Idempotente.

-- Permissão exclusiva do módulo
INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo)
VALUES (4005, 'Recebimento NF (conferência cega)', 'Compras')
ON CONFLICT (id_permissao) DO NOTHING;

-- Cabeçalho da conferência (1 por pré-nota; chave = doc+serie+fornece+loja)
CREATE TABLE IF NOT EXISTS tab_receb_conferencia (
  id               SERIAL PRIMARY KEY,
  doc              VARCHAR(20)  NOT NULL,
  serie            VARCHAR(10)  NOT NULL,
  fornece          VARCHAR(20)  NOT NULL,
  loja             VARCHAR(10)  NOT NULL,
  fornecedor_nome  TEXT,
  especie          VARCHAR(10),
  emissao          VARCHAR(8),          -- YYYYMMDD (Protheus)
  recbmto          VARCHAR(8),
  valor_bruto      NUMERIC(15,2) DEFAULT 0,
  chave_nfe        VARCHAR(50),
  qt_itens         INTEGER DEFAULT 0,
  -- RASCUNHO -> CONFERIDA (tudo bateu) | DIVERGENTE (dif != 0) -> CLASSIFICADA
  status           VARCHAR(15) NOT NULL DEFAULT 'RASCUNHO',
  observacao       TEXT,
  conferido_por    INTEGER REFERENCES tab_intranet_usr(id),
  conferido_em     TIMESTAMPTZ,
  classificado_por INTEGER REFERENCES tab_intranet_usr(id),
  classificado_em  TIMESTAMPTZ,
  protheus_resposta JSONB,
  criado_em        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (doc, serie, fornece, loja)
);

-- Itens da conferência (snapshot da SD1 + contagem física)
CREATE TABLE IF NOT EXISTS tab_receb_conferencia_item (
  id             SERIAL PRIMARY KEY,
  id_conf        INTEGER NOT NULL REFERENCES tab_receb_conferencia(id) ON DELETE CASCADE,
  item           VARCHAR(10) NOT NULL,
  produto        VARCHAR(30),
  descricao      TEXT,
  ncm            VARCHAR(15),
  um             VARCHAR(5),
  qtd_nf         NUMERIC(15,4) DEFAULT 0,   -- NUNCA vai pro front antes de finalizar (cega)
  qtd_conferida  NUMERIC(15,4),
  diferenca      NUMERIC(15,4),
  vunit          NUMERIC(15,4) DEFAULT 0,
  total          NUMERIC(15,2) DEFAULT 0,
  tes            VARCHAR(5),                -- preenchida na classificação
  cfop           VARCHAR(10),
  status_item    VARCHAR(12) DEFAULT 'PENDENTE',  -- PENDENTE | OK | DIVERGENTE
  UNIQUE (id_conf, item)
);

CREATE INDEX IF NOT EXISTS ix_receb_conf_status ON tab_receb_conferencia (status, atualizado_em DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON tab_receb_conferencia, tab_receb_conferencia_item TO intranet;
GRANT USAGE, SELECT ON SEQUENCE tab_receb_conferencia_id_seq, tab_receb_conferencia_item_id_seq TO intranet;
