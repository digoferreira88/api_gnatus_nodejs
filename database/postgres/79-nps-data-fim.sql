-- NPS Pós-venda — data limite de faturamento (teto) para o disparo.
-- Espelha a chave 'dataInicio' (piso, migration 74). 'dataFim' é OPCIONAL:
-- null = sem limite superior (comportamento atual). Idempotente.

INSERT INTO tab_nps_config (chave, valor) VALUES
  ('dataFim', 'null'::jsonb)   -- só pesquisa pedidos faturados ATÉ esta data (inclusive); null = sem teto
ON CONFLICT (chave) DO NOTHING;
