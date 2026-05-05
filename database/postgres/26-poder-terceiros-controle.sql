-- Controladoria - Poder de Terceiros (controle operacional)
-- Substitui a planilha do fiscal. Mantem em paralelo o "espelho Protheus"
-- (resources/controladoria/controladoria.poder-terceiros.js que le SB6010).
--
-- Modelagem:
--   tab_pt_envio       - 1 linha por envio (cabecalho)
--   tab_pt_envio_item  - produtos (1+ por envio)
--   tab_pt_finalizacao - registro de retorno/venda/troca/etc (0..N por envio)
--   tab_pt_finalidade  - lookup de sugestoes (texto livre na pratica)

CREATE TABLE IF NOT EXISTS tab_pt_envio (
    id                       SERIAL PRIMARY KEY,
    -- Destinatario (terceiro)
    destinatario_nome        varchar(200) NOT NULL,
    destinatario_cod         varchar(15),       -- A1_COD do Protheus (opcional)
    destinatario_loja        varchar(4),
    -- Operacao
    pedido_protheus          varchar(15),       -- C5_NUM (opcional)
    solicitante_nome         varchar(120),       -- texto livre por hora
    responsavel_nome         varchar(120),       -- responsavel interno pela mercadoria
    finalidade               varchar(80),        -- BACKUP/DEMONSTRACAO/CONSIGNADO/etc
    natureza_operacao        varchar(80),        -- COMODATO/DEMONSTRACAO/etc (rotulo fiscal)
    contrato_comodato        boolean,             -- coluna L da planilha (NAO/sim)
    -- Prazo
    prazo_dias               integer,
    ultima_validacao_em      timestamp,
    ultima_validacao_por     int REFERENCES tab_intranet_usr(id) ON DELETE SET NULL,
    -- Datas fiscais
    data_emissao_nf          date,
    data_expedicao           date,
    data_vencimento          date,                -- vencimento da operacao
    -- NF de saida
    nf_saida                 varchar(15),
    serie_saida              varchar(3),
    cfop_saida               varchar(4),
    -- Valor
    valor                    numeric(14,2),
    -- Texto livre
    observacao               text,
    cobranca_1a              text,                -- pode ser data ou descricao
    cobranca_2a              text,
    -- Status agregado: EM_ABERTO | FINALIZADO | PARCIAL
    -- (o status eh recalculado via trigger/endpoint baseado nas finalizacoes)
    status                   varchar(20) NOT NULL DEFAULT 'EM_ABERTO',
    -- Meta
    criado_por               int REFERENCES tab_intranet_usr(id) ON DELETE SET NULL,
    criado_em                timestamp NOT NULL DEFAULT NOW(),
    atualizado_por           int REFERENCES tab_intranet_usr(id) ON DELETE SET NULL,
    atualizado_em            timestamp NOT NULL DEFAULT NOW(),
    -- Marca origem (importacao em massa vs cadastro manual)
    origem                   varchar(20) DEFAULT 'manual'   -- 'manual' | 'planilha_legada'
);

CREATE TABLE IF NOT EXISTS tab_pt_envio_item (
    id              SERIAL PRIMARY KEY,
    envio_id        int NOT NULL REFERENCES tab_pt_envio(id) ON DELETE CASCADE,
    produto_cod     varchar(15),
    produto_desc    text         NOT NULL,
    quantidade      numeric(14,4) DEFAULT 1,
    valor_unit      numeric(14,2),
    serie_equip     varchar(80),         -- numero de serie do equipamento
    ordem           int DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tab_pt_finalizacao (
    id                 SERIAL PRIMARY KEY,
    envio_id           int NOT NULL REFERENCES tab_pt_envio(id) ON DELETE CASCADE,
    forma              varchar(20) NOT NULL, -- RETORNO | PARCIAL | VENDA | RENOVACAO | TROCA
    data_finalizacao   date NOT NULL,
    nf_final           varchar(15),
    serie_final        varchar(3),
    cfop_final         varchar(4),
    pedido_venda       varchar(15),
    valor_venda        numeric(14,2),
    equipamento_chegou boolean,
    observacao         text,
    registrado_por     int REFERENCES tab_intranet_usr(id) ON DELETE SET NULL,
    registrado_em      timestamp NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tab_pt_finalidade (
    codigo  varchar(50) PRIMARY KEY,
    nome    varchar(80) NOT NULL,
    ativo   boolean DEFAULT true,
    ordem   int DEFAULT 0
);

INSERT INTO tab_pt_finalidade (codigo, nome, ordem) VALUES
  ('DEMONSTRACAO',         'Demonstração',           1),
  ('BACKUP',               'Backup',                 2),
  ('CENTRO_TREINAMENTO',   'Centro de Treinamento',  3),
  ('CONSIGNADO',           'Consignado',             4),
  ('CURSO',                'Curso',                  5),
  ('TESTE_DESENVOLVIMENTO','Teste/Desenvolvimento',  6),
  ('TESTE_CALIBRACAO',     'Teste/Calibração',       7),
  ('MODELO',               'Modelo',                 8),
  ('DESENVOLVIMENTO',      'Desenvolvimento',        9),
  ('CONSERTO_GARANTIA',    'Conserto em Garantia',  10),
  ('CONSERTO',             'Conserto',              11),
  ('EXPOSICAO',            'Exposição',             12),
  ('MATERIAL_TRABALHO',    'Material de Trabalho',  13),
  ('BONIFICACAO',          'Bonificação',           14)
ON CONFLICT (codigo) DO NOTHING;

-- Indices pra dashboard e listagem
CREATE INDEX IF NOT EXISTS idx_pt_envio_status        ON tab_pt_envio (status, data_expedicao DESC);
CREATE INDEX IF NOT EXISTS idx_pt_envio_destinatario  ON tab_pt_envio (destinatario_cod, destinatario_loja);
CREATE INDEX IF NOT EXISTS idx_pt_envio_finalidade    ON tab_pt_envio (finalidade);
CREATE INDEX IF NOT EXISTS idx_pt_envio_vencimento    ON tab_pt_envio (data_vencimento) WHERE status <> 'FINALIZADO';
CREATE INDEX IF NOT EXISTS idx_pt_envio_item_envio    ON tab_pt_envio_item (envio_id);
CREATE INDEX IF NOT EXISTS idx_pt_finalizacao_envio   ON tab_pt_finalizacao (envio_id);
