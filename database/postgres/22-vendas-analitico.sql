-- ============================================================================
-- Vendas - Analitico (Onda 2 da migracao do intranet antigo):
--   - Curva ABC Faturamento (por produto)
--   - Carteira de Pedidos (pipeline por BU/vendedor)
--   - Itens sem Movimento (estoque parado)
--   - Vendas Historicas (matriz produto x ano)
--
-- Perm 2004 cobre os 4 relatorios. tab_vendas_cfop centraliza listas de CFOPs.
-- ============================================================================

INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo)
VALUES (2004, 'Vendas - Analitico', 'Vendas')
ON CONFLICT (id_permissao) DO NOTHING;

INSERT INTO tab_intranet_usr_permissoes (id_user, id_permissao, matricula)
SELECT u.id, 2004, u.matricula FROM tab_intranet_usr u WHERE u.email = 'admin@gnatus.com.br'
ON CONFLICT (id_user, id_permissao) DO NOTHING;

-- ============== tab_vendas_cfop ==============
-- Centraliza listas de CFOPs por uso (faturamento, carteira, etc).
-- Editavel via SQL ou UI futura. Migrado do params.cfop_fat e params.cfop_cart do antigo.
CREATE TABLE IF NOT EXISTS tab_vendas_cfop (
    id      SERIAL PRIMARY KEY,
    cfop    varchar(4) NOT NULL,
    uso     varchar(20) NOT NULL,    -- 'faturamento' | 'carteira'
    ativo   boolean NOT NULL DEFAULT true,
    UNIQUE (cfop, uso)
);
CREATE INDEX IF NOT EXISTS ix_vendas_cfop_uso ON tab_vendas_cfop (uso, ativo);

-- Seed faturamento (130 CFOPs migrados do antigo params.cfop_fat)
INSERT INTO tab_vendas_cfop (cfop, uso) VALUES
  ('5101','faturamento'),('5102','faturamento'),('5103','faturamento'),('5104','faturamento'),
  ('5105','faturamento'),('5106','faturamento'),('5109','faturamento'),('5110','faturamento'),
  ('5111','faturamento'),('5112','faturamento'),('5113','faturamento'),('5114','faturamento'),
  ('5115','faturamento'),('5116','faturamento'),('5117','faturamento'),('5118','faturamento'),
  ('5119','faturamento'),('5120','faturamento'),('5122','faturamento'),('5123','faturamento'),
  ('5129','faturamento'),('5251','faturamento'),('5252','faturamento'),('5253','faturamento'),
  ('5254','faturamento'),('5255','faturamento'),('5256','faturamento'),('5257','faturamento'),
  ('5258','faturamento'),('5301','faturamento'),('5302','faturamento'),('5303','faturamento'),
  ('5304','faturamento'),('5305','faturamento'),('5306','faturamento'),('5307','faturamento'),
  ('5351','faturamento'),('5352','faturamento'),('5353','faturamento'),('5354','faturamento'),
  ('5355','faturamento'),('5356','faturamento'),('5357','faturamento'),('5359','faturamento'),
  ('5360','faturamento'),('5401','faturamento'),('5402','faturamento'),('5403','faturamento'),
  ('5405','faturamento'),('5651','faturamento'),('5652','faturamento'),('5653','faturamento'),
  ('5654','faturamento'),('5655','faturamento'),('5656','faturamento'),('5667','faturamento'),
  ('5932','faturamento'),('5933','faturamento'),
  ('6101','faturamento'),('6102','faturamento'),('6103','faturamento'),('6104','faturamento'),
  ('6105','faturamento'),('6106','faturamento'),('6107','faturamento'),('6108','faturamento'),
  ('6109','faturamento'),('6110','faturamento'),('6111','faturamento'),('6112','faturamento'),
  ('6113','faturamento'),('6114','faturamento'),('6115','faturamento'),('6116','faturamento'),
  ('6117','faturamento'),('6118','faturamento'),('6119','faturamento'),('6120','faturamento'),
  ('6122','faturamento'),('6123','faturamento'),('6129','faturamento'),('6251','faturamento'),
  ('6252','faturamento'),('6253','faturamento'),('6254','faturamento'),('6255','faturamento'),
  ('6256','faturamento'),('6257','faturamento'),('6258','faturamento'),('6301','faturamento'),
  ('6302','faturamento'),('6303','faturamento'),('6304','faturamento'),('6305','faturamento'),
  ('6306','faturamento'),('6307','faturamento'),('6351','faturamento'),('6352','faturamento'),
  ('6353','faturamento'),('6354','faturamento'),('6355','faturamento'),('6356','faturamento'),
  ('6357','faturamento'),('6359','faturamento'),('6360','faturamento'),('6401','faturamento'),
  ('6402','faturamento'),('6403','faturamento'),('6404','faturamento'),('6651','faturamento'),
  ('6652','faturamento'),('6653','faturamento'),('6654','faturamento'),('6655','faturamento'),
  ('6656','faturamento'),('6667','faturamento'),('6932','faturamento'),('6933','faturamento'),
  ('7101','faturamento'),('7102','faturamento'),('7105','faturamento'),('7106','faturamento'),
  ('7127','faturamento'),('7129','faturamento'),('7251','faturamento'),('7301','faturamento'),
  ('7358','faturamento'),('7651','faturamento'),('7654','faturamento'),('7667','faturamento')
ON CONFLICT (cfop, uso) DO NOTHING;

-- Seed carteira (mesma lista + 5910/6910 que sao remessas em pedidos abertos)
INSERT INTO tab_vendas_cfop (cfop, uso)
  SELECT cfop, 'carteira' FROM tab_vendas_cfop WHERE uso = 'faturamento'
ON CONFLICT (cfop, uso) DO NOTHING;
INSERT INTO tab_vendas_cfop (cfop, uso) VALUES
  ('5910','carteira'),('6910','carteira')
ON CONFLICT (cfop, uso) DO NOTHING;
