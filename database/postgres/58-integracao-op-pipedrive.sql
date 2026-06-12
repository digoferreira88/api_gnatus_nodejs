-- Integracao OP -> Pipedrive: lista de produtos monitorados pela automacao
-- (substitui o IN(...) hardcoded no script da maquina local). Idempotente.

CREATE TABLE IF NOT EXISTS tab_op_pipedrive_produtos (
  id          SERIAL PRIMARY KEY,
  codigo      TEXT UNIQUE NOT NULL,
  descricao   TEXT,
  ativo       BOOLEAN NOT NULL DEFAULT TRUE,
  criado_por  INTEGER,
  criado_nome TEXT,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo)
SELECT 1033, 'Tecnologia - Integração OP → Pipedrive', 'Tecnologia'
WHERE NOT EXISTS (SELECT 1 FROM tab_intranet_permissoes WHERE id_permissao = 1033);
