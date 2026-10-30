-- 139 — Pix do portal do cliente: cobrança com vencimento e conciliação — 30/10/2026
--
-- 84% do saldo em aberto NÃO tem boleto gerado (R$ 30,8 mi). Para esses títulos
-- não há 2ª via para baixar: o caminho é o Pix.
--
-- Decisões do usuário (30/10):
--   · `cobv` — cobrança COM VENCIMENTO: mandamos vencimento, multa e juros, e o
--     BANCO calcula o valor no momento do pagamento. Por isso aqui ficam os
--     percentuais, não o valor final: quem fecha a conta é o PSP.
--   · A baixa no Protheus continua humana. Esta tabela é a fila que o financeiro
--     atende (`status = 'paga' AND baixado_em IS NULL`), com txid, e2eid e
--     horário para conferir no extrato.
--   · O QR é gerado sob demanda: o cliente pede no portal, a intranet cria no BB
--     e devolve na passada seguinte. A credencial do banco nunca sai da rede.
--
-- `txid` é a amarra entre o Pix recebido e o título — é por ele que o
-- `GET /pix` do Bacen devolve o pagamento. 26 a 35 alfanuméricos, sem traço.

CREATE TABLE IF NOT EXISTS tab_pix_cobranca (
  id             SERIAL PRIMARY KEY,
  txid           VARCHAR(35) NOT NULL,
  ref            VARCHAR(80) NOT NULL,         -- chave do espelho: prefixo|numero|parcela|cliente|loja

  origem         VARCHAR(10) NOT NULL DEFAULT 'portal',
  origem_id      VARCHAR(60),                  -- id do pedido no portal (idempotência)

  cliente_doc    VARCHAR(14),
  cliente_cod    VARCHAR(10),
  cliente_loja   VARCHAR(4),
  cliente_nome   VARCHAR(200),
  prefixo        VARCHAR(3),
  numero         VARCHAR(12) NOT NULL,
  parcela        VARCHAR(4),

  -- O que foi MANDADO ao banco. O valor que o cliente paga pode ser maior
  -- (multa e juros entram no ato do pagamento) — por isso valor_pago é separado.
  valor_original NUMERIC(15,2) NOT NULL,
  vencimento     DATE NOT NULL,
  multa_perc     NUMERIC(6,2),
  juros_perc     NUMERIC(6,2),

  status         VARCHAR(12) NOT NULL DEFAULT 'criando',
                 -- criando | ativa | paga | expirada | cancelada | erro
  erro           TEXT,

  copia_e_cola   TEXT,                         -- BR Code que o cliente copia
  qr_png         TEXT,                         -- PNG em base64, gerado aqui
  location       TEXT,
  loc_id         BIGINT,
  expira_em      TIMESTAMPTZ,

  -- Conciliação: o que o banco informou quando o Pix caiu.
  e2eid          VARCHAR(32),
  valor_pago     NUMERIC(15,2),
  pago_em        TIMESTAMPTZ,
  pagador_nome   VARCHAR(200),
  pagador_doc    VARCHAR(14),

  -- Baixa no Protheus: feita pelo financeiro, registrada aqui.
  baixado_em     TIMESTAMPTZ,
  baixado_por    INTEGER,
  baixa_obs      TEXT,

  publicado_em   TIMESTAMPTZ,                  -- quando este estado foi ao portal
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_pix_txid ON tab_pix_cobranca (txid);

-- Um pedido do portal vira UMA cobrança, mesmo que a resposta chegue duas vezes.
CREATE UNIQUE INDEX IF NOT EXISTS ux_pix_origem
  ON tab_pix_cobranca (origem_id) WHERE origem_id IS NOT NULL;

-- Uma cobrança viva por título: pedir de novo devolve a mesma, em vez de
-- espalhar QR Codes do mesmo título por aí.
CREATE UNIQUE INDEX IF NOT EXISTS ux_pix_ref_viva
  ON tab_pix_cobranca (ref) WHERE status IN ('criando', 'ativa');

CREATE INDEX IF NOT EXISTS ix_pix_fila_baixa
  ON tab_pix_cobranca (pago_em) WHERE status = 'paga' AND baixado_em IS NULL;
CREATE INDEX IF NOT EXISTS ix_pix_publicar
  ON tab_pix_cobranca (id) WHERE publicado_em IS NULL;
CREATE INDEX IF NOT EXISTS ix_pix_cliente ON tab_pix_cobranca (cliente_doc, criado_em DESC);

COMMENT ON TABLE tab_pix_cobranca IS
  'Cobranças Pix (cobv) dos títulos sem boleto, criadas a pedido do cliente no portal. Também é a fila de baixa do financeiro.';
COMMENT ON COLUMN tab_pix_cobranca.txid IS
  'Identificador que amarra o Pix recebido ao título: é por ele que GET /pix devolve o pagamento.';
COMMENT ON COLUMN tab_pix_cobranca.valor_original IS
  'Valor mandado ao banco. Em cobv, multa e juros são calculados pelo PSP no pagamento — o que entrou está em valor_pago.';

GRANT SELECT, INSERT, UPDATE, DELETE ON tab_pix_cobranca TO intranet;
GRANT USAGE, SELECT ON SEQUENCE tab_pix_cobranca_id_seq TO intranet;

-- Permissão da tela "Recebimentos Pix" (fila de baixa). 8005 é Envio de Boleto,
-- 8008 é Produtividade — 8009 estava livre.
INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo)
VALUES (8009, 'Financeiro - Recebimentos Pix', 'Financeiro')
ON CONFLICT (id_permissao) DO NOTHING;
