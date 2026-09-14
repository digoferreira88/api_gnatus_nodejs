-- Controle de parque + termo cobrindo a linha:
-- (A) IMEI e nº de série no equipamento (essencial p/ celulares; base da carga em lote).
-- (C) o termo de responsabilidade pode referenciar a LINHA móvel que ele cobre.
-- Aditivo e idempotente.

ALTER TABLE tab_equipamento_atual ADD COLUMN IF NOT EXISTS imei          varchar(30);
ALTER TABLE tab_equipamento_atual ADD COLUMN IF NOT EXISTS numero_serie  varchar(60);
CREATE INDEX IF NOT EXISTS ix_equip_imei ON tab_equipamento_atual (imei) WHERE imei IS NOT NULL;

ALTER TABLE tab_termo_equipamento ADD COLUMN IF NOT EXISTS id_linha int
  REFERENCES tab_telefonia_linha(id) ON DELETE SET NULL;
