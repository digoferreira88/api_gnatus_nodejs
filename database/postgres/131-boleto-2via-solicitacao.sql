-- 131 — Solicitação de 2ª via de boleto: a fila do financeiro — 09/10/2026
--
-- A 2ª via de boleto VENCIDO não é self-service (decisão do usuário): tem mora,
-- multa e, dependendo do caso, novo registro no banco. Mas dizer ao cliente
-- "fale com a cobrança" sem lugar para pedir só gera ligação. Esta é a fila.
--
-- Serve a dois caminhos:
--   1. o portal do cliente (quando existir) manda o pedido e ele cai aqui;
--   2. o próprio financeiro abre o pedido quando o cliente liga — por isso o
--      módulo tem valor desde hoje, antes de haver portal.
--
-- A conexão com o portal é sempre iniciada DAQUI: o espelho é publicado por POST
-- e os pedidos pendentes voltam na resposta. Assim não abrimos porta de entrada
-- da internet para a intranet.

CREATE TABLE IF NOT EXISTS tab_boleto_2via_solicitacao (
  id             SERIAL PRIMARY KEY,
  origem         VARCHAR(10) NOT NULL DEFAULT 'intranet',   -- portal | intranet
  -- id do pedido no portal: é por ele que a ingestão não duplica quando a mesma
  -- resposta chega duas vezes.
  origem_id      VARCHAR(60),

  -- título: mesma chave do espelho (prefixo|numero|parcela|cliente|loja)
  ref            VARCHAR(80) NOT NULL,
  prefixo        VARCHAR(3),
  numero         VARCHAR(12) NOT NULL,
  parcela        VARCHAR(4),
  cliente_cod    VARCHAR(10),
  cliente_loja   VARCHAR(4),
  cliente_doc    VARCHAR(14),
  cliente_nome   VARCHAR(200),

  vencimento     DATE,
  valor          NUMERIC(15,2),
  saldo          NUMERIC(15,2),
  dias_atraso    INTEGER,

  contato        VARCHAR(140),       -- como falar com quem pediu
  mensagem       TEXT,               -- o que o cliente escreveu

  status         VARCHAR(14) NOT NULL DEFAULT 'aberta',
                 -- aberta | em_atendimento | atendida | recusada
  resposta       TEXT,               -- o que o financeiro respondeu/fez
  novo_vencimento DATE,              -- quando houve prorrogação
  atendido_por   INTEGER,
  atendido_em    TIMESTAMPTZ,

  criado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  criado_por     INTEGER,
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Um pedido por título em aberto: reabrir o mesmo título enquanto o anterior não
-- foi atendido só duplicaria trabalho da cobrança.
CREATE UNIQUE INDEX IF NOT EXISTS ux_2via_aberta
  ON tab_boleto_2via_solicitacao (ref) WHERE status IN ('aberta', 'em_atendimento');
CREATE UNIQUE INDEX IF NOT EXISTS ux_2via_origem
  ON tab_boleto_2via_solicitacao (origem_id) WHERE origem_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_2via_status ON tab_boleto_2via_solicitacao (status, criado_em DESC);
CREATE INDEX IF NOT EXISTS ix_2via_cliente ON tab_boleto_2via_solicitacao (cliente_doc);

COMMENT ON TABLE tab_boleto_2via_solicitacao IS
  'Fila de pedidos de 2ª via que o financeiro atende. Vencido não é self-service: tem mora, multa e pode exigir novo registro no banco.';
COMMENT ON COLUMN tab_boleto_2via_solicitacao.origem_id IS
  'Id do pedido no portal. Garante que a mesma resposta chegando duas vezes não vira dois pedidos.';

GRANT SELECT, INSERT, UPDATE, DELETE ON tab_boleto_2via_solicitacao TO intranet;
GRANT USAGE, SELECT ON SEQUENCE tab_boleto_2via_solicitacao_id_seq TO intranet;
