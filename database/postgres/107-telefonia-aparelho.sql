-- Estágio 2 do controle Linhas × Colaborador × Equipamento: a linha pode apontar
-- pro APARELHO físico que carrega o chip (registro de tab_equipamento_atual, do
-- módulo RH/Equipamentos). Opcional (chip de dados/roteador fica sem aparelho;
-- notebook fica sem linha). ON DELETE SET NULL: se o equipamento for removido do
-- histórico, a linha só perde o vínculo, não some. Aditivo e idempotente.

ALTER TABLE tab_telefonia_linha
  ADD COLUMN IF NOT EXISTS id_equipamento_atual int REFERENCES tab_equipamento_atual(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ix_tel_linha_equip ON tab_telefonia_linha (id_equipamento_atual);
