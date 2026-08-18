-- Garantia × Datafrete: log do robô de acompanhamento de entrega (18/08/2026).
-- Idempotente.
--
-- O robô varre a fase "ACOMPANHAMENTO DA ENTREGA" do pipe de garantia, consulta
-- as ocorrências no Datafrete e, quando ENTREGUE, seta o status no card e move
-- pra CONCLUÍDO. Cada avaliação de card vira uma linha aqui (diagnóstico +
-- histórico); o estado vivo é o próprio Pipefy (card sai da fase ao mover).

CREATE TABLE IF NOT EXISTS tab_garantia_entrega_log (
  id         SERIAL PRIMARY KEY,
  card_id    VARCHAR(20) NOT NULL,
  card_title VARCHAR(200),
  nf         VARCHAR(20),
  serie_nf   VARCHAR(6),
  chave_nf   VARCHAR(50),
  -- SEM_NF | NF_NAO_ENCONTRADA | SEM_OCORRENCIA | EM_TRANSITO |
  -- ENTREGUE_SIMULADO | ENTREGUE_MOVIDO | ERRO_DATAFRETE | ERRO
  resultado  VARCHAR(30) NOT NULL,
  detalhe    TEXT,
  origem     VARCHAR(12) NOT NULL DEFAULT 'CRON',
  criado_em  TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_garantia_entrega_card ON tab_garantia_entrega_log (card_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS ix_garantia_entrega_data ON tab_garantia_entrega_log (criado_em DESC);
