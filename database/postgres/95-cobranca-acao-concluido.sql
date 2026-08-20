-- Cobrança · Minhas Ações: marcar uma ação de follow-up como CONCLUÍDA.
-- Sem isto, promessas antigas ficavam lembrando pra sempre. Concluída = sai da
-- fila de pendentes e para de contar no lembrete do login.
ALTER TABLE tab_cobranca_acao ADD COLUMN IF NOT EXISTS concluido    boolean NOT NULL DEFAULT false;
ALTER TABLE tab_cobranca_acao ADD COLUMN IF NOT EXISTS concluido_em timestamptz;
ALTER TABLE tab_cobranca_acao ADD COLUMN IF NOT EXISTS concluido_por int;

-- Índice parcial p/ a contagem de pendentes por usuário (lembrete do login).
CREATE INDEX IF NOT EXISTS ix_cobr_acao_pendentes
  ON tab_cobranca_acao (id_user)
  WHERE concluido = false AND data_promessa IS NOT NULL;
