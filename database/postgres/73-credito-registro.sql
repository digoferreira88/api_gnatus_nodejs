-- Registro permanente das Análises de Crédito — repositório único acoplado à
-- tela de Liberação Financeira. APPEND-ONLY + VERSIONADO: concluir uma análise
-- gera um registro imutável; "editar" NÃO sobrescreve — cria uma NOVA VERSÃO e
-- marca a anterior como substituída, preservando integralmente o histórico
-- (item 4 do escopo). Sem DELETE físico (grant sem DELETE). Usa a permissão
-- existente 8006 (Liberação Financeira) — sem permissão nova. Idempotente.

CREATE TABLE IF NOT EXISTS tab_credito_registro (
  id               SERIAL PRIMARY KEY,
  grupo_id         INTEGER NOT NULL DEFAULT 0,   -- agrupa versões da mesma análise (= id da 1ª versão)
  versao           INTEGER NOT NULL DEFAULT 1,
  vigente          BOOLEAN NOT NULL DEFAULT TRUE, -- só a última versão fica vigente
  substituido_por  INTEGER,                       -- id da versão que substituiu esta (cadeia de auditoria)

  -- Identificação
  bu_cod           VARCHAR(10),
  bu_nome          VARCHAR(120),
  pedido           VARCHAR(20),                   -- nulo em solicitação manual sem pedido
  cliente_cod      VARCHAR(20),
  cliente_loja     VARCHAR(10),
  cliente_nome     VARCHAR(200),
  cnpj             VARCHAR(20),

  -- Valores
  valor_total      NUMERIC(15,2) DEFAULT 0,
  valor_entrada    NUMERIC(15,2) DEFAULT 0,
  parcelas_qtd     INTEGER DEFAULT 0,
  parcelas_valor   NUMERIC(15,2) DEFAULT 0,

  -- Classificação
  tipo_analise     VARCHAR(40)  NOT NULL,         -- Nova análise | Reanálise | Alteração de Condição
  canal            VARCHAR(15)  NOT NULL,         -- LIBERACAO | MANUAL
  canal_origem     VARCHAR(40),                   -- MANUAL: E-mail | Teams | Comercial | Diretoria | Outros
  resultado        VARCHAR(40)  NOT NULL,         -- 7 opções padronizadas
  motivos          TEXT[]       NOT NULL DEFAULT '{}',  -- motivos padronizados marcados
  parecer          TEXT         NOT NULL,         -- parecer técnico (obrigatório)

  analista_id      INTEGER REFERENCES tab_intranet_usr(id) ON DELETE SET NULL,
  analista_nome    VARCHAR(160),
  criado_em        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_credito_registro_grupo    ON tab_credito_registro (grupo_id, versao DESC);
CREATE INDEX IF NOT EXISTS ix_credito_registro_vigente  ON tab_credito_registro (vigente, criado_em DESC);
CREATE INDEX IF NOT EXISTS ix_credito_registro_cliente  ON tab_credito_registro (cliente_cod, cliente_loja);
CREATE INDEX IF NOT EXISTS ix_credito_registro_pedido   ON tab_credito_registro (pedido);

-- Anexos do registro reaproveitam a tab_credito_anexo (migration 70, infra
-- SharePoint). registro_id = grupo_id da análise -> os anexos seguem visíveis
-- através das versões.
ALTER TABLE tab_credito_anexo ADD COLUMN IF NOT EXISTS registro_id INTEGER;
CREATE INDEX IF NOT EXISTS ix_credito_anexo_registro ON tab_credito_anexo (registro_id);

-- Integridade: SEM DELETE (o registro não pode ser excluído, item 4).
GRANT SELECT, INSERT, UPDATE ON tab_credito_registro TO intranet;
GRANT USAGE, SELECT ON SEQUENCE tab_credito_registro_id_seq TO intranet;

COMMENT ON TABLE tab_credito_registro IS
  'Histórico permanente das análises de crédito (append-only, versionado). Editar cria nova versão; nada é excluído. Acoplado à Liberação Financeira.';
