-- Painel de Gestão à Vista: +1 setor (QUALIDADE), pedido TI 28/10/2026.
-- Idempotente.
INSERT INTO tab_painel_setor (nome, ordem) VALUES
  ('QUALIDADE', 18)
ON CONFLICT (nome) DO NOTHING;
