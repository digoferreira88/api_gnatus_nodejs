-- Painel de Gestão à Vista: +2 setores (ENGENHARIA e DIGITAL), pedido TI 21/08/2026.
-- Idempotente.
INSERT INTO tab_painel_setor (nome, ordem) VALUES
  ('ENGENHARIA', 16),
  ('DIGITAL', 17)
ON CONFLICT (nome) DO NOTHING;
