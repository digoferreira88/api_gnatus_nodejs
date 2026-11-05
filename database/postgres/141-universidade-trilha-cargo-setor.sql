-- 141 — Universidade: trilha por CARGO + SETOR
--
-- O mesmo cargo existe em vários setores (ex.: Auxiliar Administrativo no Financeiro,
-- na Expedição, no SAC) e a trilha pode mudar conforme o setor. A regra de quem
-- recebe a trilha passa a ser (cargo opcional, setor opcional):
--   cargo + qualquer setor   → todos daquele cargo
--   cargo + setor            → só aquele cargo naquele setor
--   qualquer cargo + setor   → todo o setor
-- Setor = departamento do Protheus (SRA010.RA_DEPTO → SQB010).
--
-- tab_uni_cargo_trilha (140) é COPIADA para a regra nova como "cargo em qualquer
-- setor" (mesma data de criação, p/ não mexer nos prazos) e fica guardada, sem uso.
-- Mudança de setor vira evento (mudanca_setor) igual à mudança de cargo.
--
-- Aplicar como postgres (GRANTs no fim). Idempotente.

-- ---------------------------------------------------------------- setores (espelho SQB010)
CREATE TABLE IF NOT EXISTS tab_uni_departamento (
  codigo          VARCHAR(12) PRIMARY KEY,
  descricao       VARCHAR(120),
  ativo           BOOLEAN NOT NULL DEFAULT TRUE,
  sincronizado_em TIMESTAMPTZ
);
-- semente com o que já está no espelho de colaboradores (a sincronização completa pelo SQB)
INSERT INTO tab_uni_departamento (codigo, descricao)
SELECT DISTINCT ON (depto_codigo) depto_codigo, depto_desc
  FROM tab_uni_colaborador
 WHERE COALESCE(depto_codigo, '') <> ''
 ORDER BY depto_codigo, ativo DESC
ON CONFLICT (codigo) DO NOTHING;

-- ---------------------------------------------------------------- regra: quem recebe a trilha
CREATE TABLE IF NOT EXISTS tab_uni_trilha_regra (
  id           SERIAL PRIMARY KEY,
  trilha_id    INTEGER NOT NULL REFERENCES tab_uni_trilha(id) ON DELETE CASCADE,
  cargo_codigo VARCHAR(10) REFERENCES tab_uni_cargo(codigo) ON DELETE CASCADE,
  depto_codigo VARCHAR(12) REFERENCES tab_uni_departamento(codigo) ON DELETE CASCADE,
  criado_por   INTEGER,
  criado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_uni_regra_alvo CHECK (cargo_codigo IS NOT NULL OR depto_codigo IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_uni_trilha_regra
  ON tab_uni_trilha_regra (trilha_id, COALESCE(cargo_codigo, ''), COALESCE(depto_codigo, ''));
CREATE INDEX IF NOT EXISTS ix_uni_regra_cargo ON tab_uni_trilha_regra (cargo_codigo);
CREATE INDEX IF NOT EXISTS ix_uni_regra_depto ON tab_uni_trilha_regra (depto_codigo);

INSERT INTO tab_uni_trilha_regra (trilha_id, cargo_codigo, depto_codigo, criado_por, criado_em)
SELECT ct.trilha_id, ct.cargo_codigo, NULL, ct.criado_por, ct.criado_em
  FROM tab_uni_cargo_trilha ct
ON CONFLICT DO NOTHING;

COMMENT ON TABLE tab_uni_cargo_trilha IS
  'LEGADO (migration 140). Copiada para tab_uni_trilha_regra na 141; não é mais gravada. Mantida por histórico.';

-- ---------------------------------------------------------------- evento de mudança de setor
ALTER TABLE tab_uni_colaborador_evento DROP CONSTRAINT IF EXISTS chk_uni_evento_tipo;
ALTER TABLE tab_uni_colaborador_evento ADD CONSTRAINT chk_uni_evento_tipo
  CHECK (tipo IN ('carga_inicial','admissao','mudanca_cargo','mudanca_setor','desligamento','readmissao'));
COMMENT ON COLUMN tab_uni_colaborador.cargo_desde IS 'Entrada no cargo/setor atual (admissão, mudança de cargo ou de setor).';

-- ---------------------------------------------------------------- quem recebe cada trilha (view)
-- Uma linha por colaborador ativo × trilha que se aplica a ele, e por qual regra.
CREATE OR REPLACE VIEW vw_uni_colaborador_trilha AS
SELECT col.id AS colaborador_id, t.id AS trilha_id, t.criado_em::date AS desde_regra,
       'todos'::text AS via, NULL::int AS regra_id
  FROM tab_uni_colaborador col
  JOIN tab_uni_trilha t ON t.ativo AND t.publico = 'interno' AND t.aplica_todos
 WHERE col.ativo
UNION ALL
SELECT col.id, r.trilha_id, r.criado_em::date,
       CASE WHEN r.cargo_codigo IS NOT NULL AND r.depto_codigo IS NOT NULL THEN 'cargo_setor'
            WHEN r.cargo_codigo IS NOT NULL THEN 'cargo'
            ELSE 'setor' END,
       r.id
  FROM tab_uni_colaborador col
  JOIN tab_uni_trilha_regra r
    ON (r.cargo_codigo IS NULL OR r.cargo_codigo = col.cargo_codigo)
   AND (r.depto_codigo IS NULL OR r.depto_codigo = col.depto_codigo)
  JOIN tab_uni_trilha t ON t.id = r.trilha_id AND t.ativo AND t.publico = 'interno' AND NOT t.aplica_todos
 WHERE col.ativo;

-- ---------------------------------------------------------------- GRANTs (migration roda como postgres)
GRANT SELECT, INSERT, UPDATE, DELETE ON tab_uni_departamento, tab_uni_trilha_regra TO intranet;
GRANT SELECT ON vw_uni_colaborador_trilha TO intranet;
GRANT USAGE, SELECT ON SEQUENCE tab_uni_trilha_regra_id_seq TO intranet;
