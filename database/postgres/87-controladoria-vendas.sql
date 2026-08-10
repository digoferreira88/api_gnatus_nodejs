-- Controladoria — automação do relatório mensal de vendas (Fase 0: base versionada).
-- A controladoria entrega mensalmente um xlsx tratado (aba "BD", nível item =
-- Pedido+Seq, base histórica inteira). Aqui guardamos cada entrega como um SNAPSHOT
-- mensal, pra depois (Fase 1) diffar entre meses + cruzar com Protheus (devolvido/
-- excluído) e (Fase 2) gerar as visões Geral/Digital/Varejo.

-- Snapshot mensal da BD (item-level). Re-importar um mês = DELETE + reload.
CREATE TABLE IF NOT EXISTS tab_ctrl_vendas_snapshot (
  id             BIGSERIAL PRIMARY KEY,
  snapshot_mes   VARCHAR(6)  NOT NULL,   -- 'YYYYMM' do arquivo entregue (mês de referência)
  filial         VARCHAR(4),
  pedido         VARCHAR(20) NOT NULL,
  seq            VARCHAR(6),
  tipo           TEXT,                   -- Tipo (bruto)
  tipo_considerar TEXT,                  -- "Tipo a considerar" (tratativa: Pedido Devolvido/Desconsiderar/...)
  estatus        TEXT,
  nf             VARCHAR(20),
  emissao        DATE,
  data_base      DATE,
  ano            INTEGER,
  forma_pagto    TEXT,
  vendedor_cod   VARCHAR(10),
  vendedor_nome  TEXT,
  cliente_cod    VARCHAR(12),
  tipo_cli       VARCHAR(4),
  cliente_nome   TEXT,
  cpf_cnpj       VARCHAR(20),
  codigo         VARCHAR(30),
  descricao      TEXT,
  unidade        VARCHAR(8),
  classificacao  TEXT,
  grupo          TEXT,
  quantidade     NUMERIC(15,3),
  unitario       NUMERIC(15,4),
  total_item     NUMERIC(15,2),
  total_pedido   NUMERIC(15,2),          -- ⚠️ só vem preenchido na seq 01 (valor do pedido)
  total_faturado NUMERIC(15,2),
  tes            VARCHAR(10),
  cfop           VARCHAR(10),
  destino        VARCHAR(4),
  regiao         TEXT,
  municipio      TEXT,
  cidade         TEXT,
  chave_cidade   TEXT,
  considera_qtd  TEXT,
  vendedor_considerar TEXT,
  raw            JSONB,                  -- todas as 54 colunas (nome->valor), nada se perde
  criado_em      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_ctrl_vendas_mes        ON tab_ctrl_vendas_snapshot (snapshot_mes);
CREATE INDEX IF NOT EXISTS ix_ctrl_vendas_ped        ON tab_ctrl_vendas_snapshot (pedido, seq);
CREATE INDEX IF NOT EXISTS ix_ctrl_vendas_mes_ped    ON tab_ctrl_vendas_snapshot (snapshot_mes, pedido);
CREATE INDEX IF NOT EXISTS ix_ctrl_vendas_considerar ON tab_ctrl_vendas_snapshot (snapshot_mes, tipo_considerar);
CREATE INDEX IF NOT EXISTS ix_ctrl_vendas_ano        ON tab_ctrl_vendas_snapshot (ano);

-- Registro das importações (auditoria + status do processamento assíncrono).
CREATE TABLE IF NOT EXISTS tab_ctrl_vendas_import (
  id             SERIAL PRIMARY KEY,
  snapshot_mes   VARCHAR(6) NOT NULL,
  arquivo        TEXT,
  linhas         INTEGER,
  status         VARCHAR(12) DEFAULT 'PROCESSANDO',   -- PROCESSANDO|CONCLUIDO|ERRO
  erro           TEXT,
  importado_por  INTEGER,
  iniciado_em    TIMESTAMPTZ DEFAULT NOW(),
  concluido_em   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_ctrl_vendas_import_mes ON tab_ctrl_vendas_import (snapshot_mes, iniciado_em DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON tab_ctrl_vendas_snapshot, tab_ctrl_vendas_import TO intranet;
GRANT USAGE, SELECT ON SEQUENCE tab_ctrl_vendas_snapshot_id_seq, tab_ctrl_vendas_import_id_seq TO intranet;

-- Permissão do módulo (Controladoria — 11001-11005 já usados; 11006 livre).
INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo)
VALUES (11006, 'Controladoria - Vendas (relatório mensal)', 'Controladoria')
ON CONFLICT (id_permissao) DO UPDATE SET nome = EXCLUDED.nome, modulo = EXCLUDED.modulo;

INSERT INTO tab_intranet_usr_permissoes (id_user, id_permissao, matricula)
SELECT u.id, 11006, u.matricula FROM tab_intranet_usr u WHERE u.email = 'admin@gnatus.com.br'
ON CONFLICT (id_user, id_permissao) DO NOTHING;
