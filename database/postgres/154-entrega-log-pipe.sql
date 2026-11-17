-- Aplicar como postgres ANTES de recarregar a API com este código.
-- 154 — Entrega × Datafrete: o robô passa a acompanhar mais de um pipe — 17/11/2026
--
-- O robô que concluía os cards do pipe de Garantia quando o Datafrete acusa a
-- entrega (migration 94) agora atende uma lista de pipes (services/pipefyGarantia.js,
-- ROBOS). O log continua na mesma tabela; esta coluna diz de qual pipe é a linha.
-- As linhas antigas são todas da Garantia (306873829), daí o DEFAULT.
--
-- Idempotente: pode rodar de novo sem efeito. Sem GRANT: coluna nova em tabela
-- existente herda as permissões da tabela.

ALTER TABLE tab_garantia_entrega_log
  ADD COLUMN IF NOT EXISTS pipe_id VARCHAR(20) NOT NULL DEFAULT '306873829';

CREATE INDEX IF NOT EXISTS ix_garantia_entrega_pipe ON tab_garantia_entrega_log (pipe_id, criado_em DESC);
