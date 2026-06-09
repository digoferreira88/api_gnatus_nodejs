-- Modulo Credito — integracao com bureau externo (Quod). Fase 1/2. Idempotente.
-- Cache de consulta (evita re-consultar/re-pagar) + log de consultas (auditoria/
-- custo/LGPD) + config de blend/travas/TTL + permissao 15104.

-- Cache por (cnpj, fonte) — 30 dias por padrao (config bureau.cacheTtlDias)
CREATE TABLE IF NOT EXISTS tab_credito_cache (
  cnpj          TEXT NOT NULL,
  fonte         TEXT NOT NULL,                 -- 'quod', etc.
  payload       JSONB NOT NULL,                -- resultado NORMALIZADO do bureau
  consultado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expira_em     TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (cnpj, fonte)
);

-- Log de TODA consulta externa (auditoria + custo + LGPD)
CREATE TABLE IF NOT EXISTS tab_credito_consulta_externa (
  id            SERIAL PRIMARY KEY,
  cliente_cod   TEXT, cliente_loja TEXT, cnpj TEXT NOT NULL,
  fonte         TEXT NOT NULL,
  http_status   INTEGER,
  do_cache      BOOLEAN NOT NULL DEFAULT FALSE,
  payload       JSONB,
  custo         NUMERIC(10,2),
  usuario_id    INTEGER,
  consultado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_credito_consulta_cnpj ON tab_credito_consulta_externa (cnpj, consultado_em DESC);

-- Config do blend / travas / TTL (editavel)
INSERT INTO tab_credito_config (chave, valor) VALUES
('bureau', '{
  "fonteAtiva": "quod",
  "pesoExterno": 0.4,
  "cacheTtlDias": 30,
  "tetoProtestoAtivo": 400,
  "tetoRestricaoGrave": 500
}'::jsonb)
ON CONFLICT (chave) DO NOTHING;

-- Permissao dedicada (gera custo)
INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo)
SELECT 15104, 'Crédito - Consulta externa (Quod / custo)', 'Crédito'
WHERE NOT EXISTS (SELECT 1 FROM tab_intranet_permissoes WHERE id_permissao = 15104);
