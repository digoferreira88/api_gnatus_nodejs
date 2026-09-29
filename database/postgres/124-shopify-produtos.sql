-- 124 — Espelho de PRODUTOS Protheus -> loja Shopify (29/09/2026)
--
-- Objetivo: alimentar a loja Shopify com os produtos que a ACV (Categoria x Grupo ou
-- Produto) marcar, com preço da tabela DA1 escolhida (007 = AT ATACADO 2025). Carga
-- inicial + sincronismo contínuo, SENTIDO ÚNICO (Protheus -> Shopify).
--
-- MODELO DE PROPRIEDADE DO DADO (decisão do usuário, 29/09) — é o que governa o motor:
--   Protheus manda em: SKU (B1_COD), preço (DA1_PRCVEN) e situação (B1_MSBLQL/B1_ZOBSOLE).
--   Protheus manda no TÍTULO só na CRIAÇÃO.
--   Shopify manda em: descrição, fotos, peso, dimensões, SEO, coleções — NUNCA tocados.
--
-- Consequência técnica (a armadilha desta integração): a mutation `productSet` do
-- Shopify é upsert idempotente, mas para campos de LISTA (mídia, metafields, variantes)
-- ela APAGA o que não vier no input. Usá-la no update limparia silenciosamente as fotos
-- e descrições cadastradas na loja. Por isso o motor só usa productSet na CRIAÇÃO;
-- update de preço vai por productVariantsBulkUpdate e de situação por productUpdate.
--
-- Estado real do Protheus quando isto foi escrito (medido, não presumido):
--   ACU010 (categorias) e ACV010 (vínculo) estão VAZIAS -> o espelho lê 0 produtos até
--   o cadastro no ERP acontecer. Isso é esperado; a tela de prévia existe justamente
--   para o pessoal do Protheus enxergar o cadastro enquanto o faz.
--   Tabela DA1 007: 2.048 SKUs com preço ativo.
--
-- Sobe DESLIGADO: sem SHOPIFY_TOKEN + SHOPIFY_ATIVO=1 o serviço fica dormente.

-- Estado por SKU (1 linha por B1_COD; a loja é chaveada pelo SKU da variante)
CREATE TABLE IF NOT EXISTS tab_shopify_produto_sync (
  codigo        TEXT PRIMARY KEY,             -- B1_COD (RTRIM) = SKU na Shopify
  product_id    TEXT,                         -- gid://shopify/Product/...
  variant_id    TEXT,                         -- gid://shopify/ProductVariant/...
  hash          TEXT,                         -- hash dos campos que o Protheus possui
  status        TEXT NOT NULL DEFAULT 'ok',   -- ok | seed | orfao | arquivado | erro
  erro          TEXT,
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE tab_shopify_produto_sync IS
  'Espelho Protheus -> Shopify: product_id/variant_id + hash por SKU. O diff é feito em Postgres p/ só o delta ir a API. status orfao = existe na loja e nao na ACV (nao mexe — o espelho e aditivo).';

-- Contador de gravações (create/update) por dia, p/ o teto diário do backfill.
CREATE TABLE IF NOT EXISTS tab_shopify_ctrl (
  dia        DATE PRIMARY KEY,
  gravacoes  INTEGER NOT NULL DEFAULT 0
);

COMMENT ON TABLE tab_shopify_ctrl IS
  'Gravacoes (productSet + productVariantsBulkUpdate + productUpdate) enviadas a Shopify por dia. Teto = SHOPIFY_TETO_DIA (.env).';

-- Log de cada ciclo (auditoria/observabilidade — igual ao tab_pipefy_clientes_log).
CREATE TABLE IF NOT EXISTS tab_shopify_log (
  id           BIGSERIAL PRIMARY KEY,
  origem       TEXT,                           -- CRON | MANUAL | SEED
  catalogo     INTEGER NOT NULL DEFAULT 0,     -- SKUs que a ACV trouxe
  criados      INTEGER NOT NULL DEFAULT 0,
  atualizados  INTEGER NOT NULL DEFAULT 0,
  arquivados   INTEGER NOT NULL DEFAULT 0,
  erros        INTEGER NOT NULL DEFAULT 0,
  simulado     BOOLEAN NOT NULL DEFAULT FALSE, -- ciclo em dry-run (SHOPIFY_SIMULAR=1)
  detalhe      TEXT,
  criado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_shopify_log_data ON tab_shopify_log (criado_em DESC);

-- Permissão do módulo no catálogo (tela Editar Permissões). Faixa 22xxx livre
-- (21001-3 são da Qualidade, migration 123). Idempotente.
INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo)
SELECT 22001, 'Shopify - Espelho de produtos', 'Tecnologia'
 WHERE NOT EXISTS (SELECT 1 FROM tab_intranet_permissoes WHERE id_permissao = 22001);

-- ⚠️ Em produção esta migration roda como o role `postgres` (via
-- `sudo cat ... | sudo -u postgres psql`, porque /home/intranet é 750 e o psql -f
-- não consegue abrir o arquivo). Tabela NOVA criada assim nasce pertencendo ao
-- postgres e a aplicação (role `intranet`) não enxerga. Por isso os GRANTs abaixo —
-- sem eles a aba Espelho quebra com "permission denied for table". Idempotentes.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE tab_shopify_produto_sync TO intranet;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE tab_shopify_ctrl          TO intranet;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE tab_shopify_log           TO intranet;
GRANT USAGE, SELECT ON SEQUENCE tab_shopify_log_id_seq TO intranet;
