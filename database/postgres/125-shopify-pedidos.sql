-- 125 — Pedido da loja Shopify -> Protheus (29/09/2026)
--
-- Fecha o ciclo do módulo Shopify: o catálogo já vai do Protheus para a loja
-- (migration 124); esta parte traz o PEDIDO de volta.
--
-- COMO O PEDIDO ENTRA NO ERP — reaproveita o caminho do portal B2B atual, que roda
-- há anos com 11.006 pedidos: grava uma linha por item na tabela de staging
-- `MURO.dbo.SZ6010` e uma rotina ADVPL do lado do Protheus lê, cria o pedido de
-- venda e DEVOLVE o número em `Z6_NUM`.
--
-- Por que não é o EAI/MATA010: o adapter SALESORDER existe só na base TESTE e o EAI
-- desta instalação nunca carregou tráfego real (últimas mensagens de 2021). A rota
-- da SZ6010 é a que está viva e não exige ADVPL novo.
--
-- O que NÃO é nosso: a TES. Medido cruzando SZ6010 × SC6010 — a rotina atribui
-- sozinha (531 em 9.489 pedidos, 530, e 588/589 de SUFRAMA corretos). O portal nunca
-- mandou TES. Também não é triangular: C5_TIPO='N' em 100% dos pedidos.
--
-- ⚠️ ESCRITA NO PROTHEUS. É a 4ª exceção à regra de só-leitura da intranet. É
-- staging (não documento), mas DISPARA criação de pedido de verdade. Por isso o
-- módulo sobe desligado e em simulação.
--
-- ⚠️ A rotina ADVPL falha em silêncio: 17 dos 11.006 pedidos do portal entraram na
-- staging e nunca viraram número, sem causa óbvia nos dados (produto existe, cliente
-- existe, nada bloqueado) e sem ninguém ser avisado. Hoje há um humano no meio que
-- percebe; quando o pedido passa a entrar sozinho, esse humano some — daí a coluna
-- `enviado_em` e o conceito de pedido TRAVADO.

-- Um registro por pedido da loja.
CREATE TABLE IF NOT EXISTS tab_shopify_pedido (
  order_number   INTEGER PRIMARY KEY,          -- o #1001 que o cliente vê (curto; cabe no Z6_IDPORTAL int)
  shopify_id     TEXT,                         -- gid://shopify/Order/... (13 dígitos, NÃO cabe no Z6_IDPORTAL)
  cnpj           TEXT,                         -- do comprador; é por ele que o ERP resolve o cliente
  cliente_erp    TEXT,                         -- A1_COD quando resolvido aqui
  itens          INTEGER NOT NULL DEFAULT 0,
  valor          NUMERIC(14,2),
  frete          NUMERIC(14,2) NOT NULL DEFAULT 0,
  cond_pag       TEXT,                         -- Z6_COND
  forma_pag      TEXT,                         -- Z6_FORMAPG
  tabela_preco   TEXT,                         -- Z6_TABELA
  transportadora TEXT,                         -- Z6_TRANSP
  status         TEXT NOT NULL DEFAULT 'recebido',  -- recebido | enviado | confirmado | erro | ignorado
  pedido_erp     TEXT,                         -- Z6_NUM devolvido pela rotina do Protheus
  erro           TEXT,
  recebido_em    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  enviado_em     TIMESTAMPTZ,                  -- quando as linhas foram para a SZ6010
  confirmado_em  TIMESTAMPTZ,                  -- quando o Z6_NUM apareceu
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE tab_shopify_pedido IS
  'Pedido da loja Shopify -> staging MURO.dbo.SZ6010 -> pedido no Protheus. order_number e a chave (vai no Z6_IDPORTAL, que e int e nao comporta o id de 13 digitos do Shopify). status enviado sem pedido_erp por muito tempo = TRAVADO, precisa alerta.';

-- Pedido enviado e sem retorno há tempo demais = a rotina ADVPL engoliu em silêncio.
CREATE INDEX IF NOT EXISTS ix_shopify_pedido_travado
    ON tab_shopify_pedido (enviado_em)
 WHERE status = 'enviado' AND pedido_erp IS NULL;

CREATE INDEX IF NOT EXISTS ix_shopify_pedido_status ON tab_shopify_pedido (status);

CREATE TABLE IF NOT EXISTS tab_shopify_pedido_log (
  id           BIGSERIAL PRIMARY KEY,
  order_number INTEGER,
  origem       TEXT,                            -- WEBHOOK | CRON | MANUAL
  acao         TEXT,                            -- recebido | enviado | confirmado | erro | simulado
  detalhe      TEXT,
  criado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_shopify_pedido_log_data ON tab_shopify_pedido_log (criado_em DESC);
CREATE INDEX IF NOT EXISTS ix_shopify_pedido_log_pedido ON tab_shopify_pedido_log (order_number);

-- Permissão: mesma tela do módulo Shopify (22001), sem permissão nova.

-- ⚠️ Em produção esta migration roda como o role `postgres`; tabela nova nasce dele
-- e a aplicação (role `intranet`) não enxerga. Idempotentes.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE tab_shopify_pedido     TO intranet;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE tab_shopify_pedido_log TO intranet;
GRANT USAGE, SELECT ON SEQUENCE tab_shopify_pedido_log_id_seq TO intranet;
