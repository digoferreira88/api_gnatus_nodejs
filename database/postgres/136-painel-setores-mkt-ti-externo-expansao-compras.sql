-- Painel de Gestão à Vista: +5 setores, pedido TI 28/10/2026.
-- (DIRETORIA também foi pedido, mas já existe desde a 97.)
-- Idempotente.
INSERT INTO tab_painel_setor (nome, ordem) VALUES
  ('MARKETING', 19),
  ('TI', 20),
  ('EXTERNO', 21),
  ('EXPANSÃO', 22),
  ('COMPRAS', 23)
ON CONFLICT (nome) DO NOTHING;
