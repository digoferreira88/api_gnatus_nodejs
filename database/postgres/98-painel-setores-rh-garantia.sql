-- Painel de Gestão à Vista: +2 setores (RH e GARANTIA), pedido TI 21/08/2026.
-- Idempotente.
INSERT INTO tab_painel_setor (nome, ordem) VALUES
  ('RH', 14),
  ('GARANTIA', 15)
ON CONFLICT (nome) DO NOTHING;
