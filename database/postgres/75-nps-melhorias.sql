-- NPS Pós-venda — melhorias: lembrete D+3, anti-fadiga, alerta de detrator
-- crítico e segmentação (BU / vendedor / transportadora / linha de produto).
-- Idempotente.

-- Segmentação + controle de lembrete no convite
ALTER TABLE tab_nps_convite ADD COLUMN IF NOT EXISTS bu_cod VARCHAR(10);
ALTER TABLE tab_nps_convite ADD COLUMN IF NOT EXISTS bu_nome VARCHAR(120);
ALTER TABLE tab_nps_convite ADD COLUMN IF NOT EXISTS vendedor_cod VARCHAR(10);
ALTER TABLE tab_nps_convite ADD COLUMN IF NOT EXISTS vendedor_nome VARCHAR(120);
ALTER TABLE tab_nps_convite ADD COLUMN IF NOT EXISTS transportadora_cod VARCHAR(10);
ALTER TABLE tab_nps_convite ADD COLUMN IF NOT EXISTS transportadora_nome VARCHAR(120);
ALTER TABLE tab_nps_convite ADD COLUMN IF NOT EXISTS linha_cod VARCHAR(20);
ALTER TABLE tab_nps_convite ADD COLUMN IF NOT EXISTS linha_desc VARCHAR(120);
ALTER TABLE tab_nps_convite ADD COLUMN IF NOT EXISTS lembrete_em TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS ix_nps_convite_bu   ON tab_nps_convite (bu_cod);
CREATE INDEX IF NOT EXISTS ix_nps_convite_vend ON tab_nps_convite (vendedor_cod);

-- Novas configs (default): lembrete D+3, anti-fadiga 30d, detrator crítico ≤3,
-- lista de e-mails que recebem o alerta em tempo real.
INSERT INTO tab_nps_config (chave, valor) VALUES
  ('lembreteDias',   '3'::jsonb),
  ('antifadigaDias', '30'::jsonb),
  ('criticoMax',     '3'::jsonb),
  ('alertaEmails',   '[]'::jsonb)
ON CONFLICT (chave) DO NOTHING;
