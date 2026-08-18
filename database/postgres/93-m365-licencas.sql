-- Dashboard de Licenças Microsoft 365 (18/08/2026). Idempotente.
--
-- Os totais/uso vêm AO VIVO do Graph (subscribedSkus, via services/m365.js — a
-- mesma app registration do Provisionamento). Aqui só persiste o que o Graph não
-- tem: o VALOR MENSAL que pagamos por licença de cada SKU (contrato/revenda),
-- cadastrado pela TI. Chave = skuPartNumber (estável e legível; o skuId é GUID).

INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo) VALUES
  (1035, 'Tecnologia - Licenças 365 (dashboard)', 'Tecnologia')
ON CONFLICT (id_permissao) DO NOTHING;

CREATE TABLE IF NOT EXISTS tab_m365_licenca_custo (
  sku_part_number VARCHAR(80) PRIMARY KEY,
  valor_mensal    NUMERIC(12,2) NOT NULL CHECK (valor_mensal >= 0),
  obs             VARCHAR(200),
  atualizado_por  VARCHAR(120),
  atualizado_em   TIMESTAMP NOT NULL DEFAULT NOW()
);
