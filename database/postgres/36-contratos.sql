-- Apoio Gerencial - Gestao de Contratos (Onda 1)
-- Cobre 6 tipos: Locacao, Fornecimento, Manutencao, Comodato, Cliente, PJ.
-- Estrutura preparada pra Onda 2 (reajuste/aditivos/alertas) e Onda 3 (assinatura).
--
-- Status do contrato e CALCULADO em runtime (nao gravado):
--   RASCUNHO   -> data_inicio = NULL OU explicito
--   VIGENTE    -> hoje BETWEEN vigencia_inicio AND vigencia_fim - 90d
--   VENCENDO   -> vigencia_fim - 90d <= hoje <= vigencia_fim
--   VENCIDO    -> hoje > vigencia_fim
--   RENOVADO   -> tem aditivo de prazo aprovado (Onda 2)
--   ENCERRADO  -> flag explicita (encerramento antecipado)
--   CANCELADO  -> nunca virou vigente

CREATE TABLE IF NOT EXISTS tab_contrato (
    id              SERIAL PRIMARY KEY,
    numero          varchar(30) NOT NULL UNIQUE,         -- ex CT/2026/0001 (auto-gerado)
    tipo            varchar(20) NOT NULL,                -- LOCACAO | FORNECIMENTO | MANUTENCAO | COMODATO | CLIENTE | PJ
    titulo          varchar(200) NOT NULL,
    descricao       text,

    -- Contraparte (cliente, fornecedor ou pessoa fisica)
    contraparte_tipo  varchar(15) NOT NULL,              -- CLIENTE | FORNECEDOR | PESSOA_FISICA | OUTRO
    contraparte_cod   varchar(20),                       -- A1_COD / A2_COD (se vinculado ao Protheus)
    contraparte_loja  varchar(5),
    contraparte_nome  varchar(200) NOT NULL,
    contraparte_cnpj  varchar(20),
    contraparte_email varchar(120),
    contraparte_tel   varchar(30),
    contraparte_endereco text,

    -- Responsavel interno (quem gerencia)
    id_user_responsavel    int REFERENCES tab_intranet_usr(id) ON DELETE SET NULL,
    responsavel_nome       varchar(120),
    responsavel_email      varchar(120),
    responsavel_departamento varchar(80),

    -- Vigencia
    vigencia_inicio   date,
    vigencia_fim      date,

    -- Valores
    valor_total       numeric(14,2),                     -- valor total do contrato (se aplicavel)
    valor_mensal      numeric(14,2),                     -- valor mensal recorrente (locacao, fornecimento)
    moeda             varchar(5) NOT NULL DEFAULT 'BRL',

    -- Reajuste
    indice_reajuste            varchar(10),              -- IPCA | IGPM | INPC | IGPC | SELIC | NENHUM
    mes_aniversario_reajuste   int CHECK (mes_aniversario_reajuste BETWEEN 1 AND 12),
    dia_vencimento_mensal      int CHECK (dia_vencimento_mensal BETWEEN 1 AND 31),

    -- Renovacao
    renovacao_automatica       boolean NOT NULL DEFAULT false,
    prazo_renovacao_meses      int,                      -- ex 12

    -- Encerramento
    encerrado            boolean NOT NULL DEFAULT false,
    data_encerramento    date,
    motivo_encerramento  text,

    -- Campos extras especificos por tipo (endereco do imovel pra LOCACAO,
    -- equipamento pra MANUTENCAO, escopo de servico pra FORNECIMENTO etc).
    meta              jsonb,

    -- Auditoria
    observacoes       text,
    id_user_criou     int REFERENCES tab_intranet_usr(id) ON DELETE SET NULL,
    id_user_atualizou int REFERENCES tab_intranet_usr(id) ON DELETE SET NULL,
    criado_em         timestamp NOT NULL DEFAULT NOW(),
    atualizado_em     timestamp NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_contrato_tipo       ON tab_contrato (tipo);
CREATE INDEX IF NOT EXISTS ix_contrato_vigencia   ON tab_contrato (vigencia_fim);
CREATE INDEX IF NOT EXISTS ix_contrato_contrap    ON tab_contrato (contraparte_cod, contraparte_loja);
CREATE INDEX IF NOT EXISTS ix_contrato_responsavel ON tab_contrato (id_user_responsavel);

-- Aditivos (Onda 2 — tabela ja criada pra simplificar a evolucao)
CREATE TABLE IF NOT EXISTS tab_contrato_aditivo (
    id              SERIAL PRIMARY KEY,
    id_contrato     int NOT NULL REFERENCES tab_contrato(id) ON DELETE CASCADE,
    numero          varchar(10) NOT NULL,                -- 1º, 2º, 3º...
    tipo            varchar(20) NOT NULL,                -- VALOR | PRAZO | ESCOPO | REAJUSTE | MISTO
    data_assinatura date,
    -- Snapshot dos campos alterados
    valor_total_novo  numeric(14,2),
    valor_mensal_novo numeric(14,2),
    vigencia_fim_novo date,
    descricao         text,
    -- Aprovacao
    id_user_aprovador int REFERENCES tab_intranet_usr(id) ON DELETE SET NULL,
    aprovado_em       timestamp,
    status            varchar(20) NOT NULL DEFAULT 'RASCUNHO',  -- RASCUNHO | APROVADO | CANCELADO
    id_user_criou     int REFERENCES tab_intranet_usr(id) ON DELETE SET NULL,
    criado_em         timestamp NOT NULL DEFAULT NOW(),
    UNIQUE (id_contrato, numero)
);
CREATE INDEX IF NOT EXISTS ix_contrato_adit_contrato ON tab_contrato_aditivo (id_contrato);

-- Anexos (PDF do contrato, documentos do contratado etc).
-- Estrategia bytea inline — mesmos contratos sao max ~5MB cada, volume baixo (200-500).
CREATE TABLE IF NOT EXISTS tab_contrato_anexo (
    id              SERIAL PRIMARY KEY,
    id_contrato     int NOT NULL REFERENCES tab_contrato(id) ON DELETE CASCADE,
    nome_arquivo    varchar(200) NOT NULL,
    mime_type       varchar(120),
    tamanho_bytes   int,
    conteudo        bytea NOT NULL,
    descricao       varchar(200),
    id_user         int REFERENCES tab_intranet_usr(id) ON DELETE SET NULL,
    criado_em       timestamp NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_contrato_anexo_c ON tab_contrato_anexo (id_contrato);

-- Log de alertas enviados (cron de vencimento — Onda 2)
CREATE TABLE IF NOT EXISTS tab_contrato_alerta (
    id              SERIAL PRIMARY KEY,
    id_contrato     int NOT NULL REFERENCES tab_contrato(id) ON DELETE CASCADE,
    tipo_alerta     varchar(20) NOT NULL,                -- VENCIMENTO_90 | VENCIMENTO_60 | VENCIMENTO_30 | REAJUSTE | OUTRO
    canal           varchar(10) NOT NULL,                -- EMAIL | WHATSAPP
    destinatario    varchar(200),
    status          varchar(15) NOT NULL DEFAULT 'ENVIADO',  -- ENVIADO | FALHA
    detalhe         text,
    criado_em       timestamp NOT NULL DEFAULT NOW(),
    -- evita reenvio do mesmo alerta no mesmo dia
    UNIQUE (id_contrato, tipo_alerta, canal, criado_em)
);
CREATE INDEX IF NOT EXISTS ix_contrato_alerta_c ON tab_contrato_alerta (id_contrato, criado_em DESC);

-- Permissoes (faixa Apoio Gerencial 5xxx)
INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo) VALUES
  (5002, 'Apoio Gerencial - Contratos (Ver)',     'Apoio Gerencial'),
  (5003, 'Apoio Gerencial - Contratos (Editar)',  'Apoio Gerencial'),
  (5004, 'Apoio Gerencial - Contratos (Aprovar Aditivos)', 'Apoio Gerencial')
ON CONFLICT (id_permissao) DO UPDATE
   SET nome = EXCLUDED.nome, modulo = EXCLUDED.modulo;
