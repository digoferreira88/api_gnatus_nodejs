-- Integracao OP -> Pipefy (o alvo real e Pipefy, nao Pipedrive — renomeia) +
-- estado das OPs sincronizadas + log de execucoes. Idempotente.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tab_op_pipedrive_produtos')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tab_op_pipefy_produtos') THEN
    ALTER TABLE tab_op_pipedrive_produtos RENAME TO tab_op_pipefy_produtos;
  END IF;
END $$;

-- id do registro do produto na TABELA de produtos do Pipefy (campo conector do card)
ALTER TABLE tab_op_pipefy_produtos ADD COLUMN IF NOT EXISTS id_pipefy TEXT;

UPDATE tab_intranet_permissoes
   SET nome = 'Tecnologia - Integração OP → Pipefy'
 WHERE id_permissao = 1033;

-- Estado: 1 linha por OP+serie ja vista (id_pipefy = card criado)
CREATE TABLE IF NOT EXISTS tab_op_pipefy_ops (
  id            SERIAL PRIMARY KEY,
  op            TEXT NOT NULL,
  numserie      TEXT NOT NULL DEFAULT '1',
  produto       TEXT NOT NULL,
  descricao     TEXT,
  inicio        DATE,
  fim           DATE,
  id_pipefy     TEXT,                -- card id no Pipefy (null = ainda nao criado)
  erro          TEXT,                -- ultimo erro ao criar/atualizar card
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (op, numserie)
);

-- Log de execucoes da sincronizacao
CREATE TABLE IF NOT EXISTS tab_op_pipefy_log (
  id            SERIAL PRIMARY KEY,
  origem        TEXT NOT NULL,       -- CRON | MANUAL
  ops_vistas    INTEGER NOT NULL DEFAULT 0,
  cards_criados INTEGER NOT NULL DEFAULT 0,
  cards_atualizados INTEGER NOT NULL DEFAULT 0,
  erros         INTEGER NOT NULL DEFAULT 0,
  detalhe       TEXT,
  executado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
