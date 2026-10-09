-- 129 — CIOSP: lista de preço do evento — 09/10/2026
--
-- Medido antes de escrever: NENHUMA tabela de preço do ERP precifica o equipamento
-- acabado que o CIOSP vende. A maior tabela de venda (009) tem teto de R$ 19,5 mil e
-- só 522 itens fora do grupo de peças; o ticket médio do CIOSP 2026 foi R$ 20 mil.
-- Por isso o campo de tabela de preço está vazio nos 538 lançamentos E nos pedidos
-- do Protheus: o preço do evento sempre viveu fora do sistema.
--
-- Esta tabela é o lugar dele. A política de preço é publicada pouco antes de cada
-- evento; aqui ela vira uma lista por edição, e o catálogo do vendedor passa a
-- responder com o preço certo em vez de o vendedor digitar de cabeça.
--
-- O catálogo continua caindo na tabela do ERP (DA1) para o que ela sabe responder —
-- peça de reposição e assistência técnica, que é onde ela é boa.

CREATE TABLE IF NOT EXISTS tab_ciosp_preco (
  id            SERIAL PRIMARY KEY,
  edicao        VARCHAR(40) NOT NULL,
  produto       VARCHAR(15),                 -- B1_COD quando o item existe no ERP
  descricao     VARCHAR(200) NOT NULL,
  modelo        VARCHAR(80),
  familia       VARCHAR(40),                 -- bloco do talão: Imagem, Biossegurança, Cirurgia…
  preco         NUMERIC(15,2) NOT NULL,      -- preço à vista da política do evento
  preco_prazo   NUMERIC(15,2),               -- quando a política traz os dois
  desconto_max  NUMERIC(6,2) NOT NULL DEFAULT 0,  -- até onde o vendedor vai sem aprovação
  prazo_fabric  INTEGER,                     -- dias, entra no cálculo do prazo de entrega
  ativo         BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  criado_por    INTEGER
);

CREATE INDEX IF NOT EXISTS ix_ciosp_preco_edicao ON tab_ciosp_preco (edicao, ativo);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ciosp_preco_item
  ON tab_ciosp_preco (edicao, COALESCE(produto, ''), descricao);

COMMENT ON TABLE tab_ciosp_preco IS
  'Política de preço do evento. É a fonte primária do catálogo do vendedor; sem linha aqui, o catálogo cai na tabela do ERP (DA1).';
COMMENT ON COLUMN tab_ciosp_preco.desconto_max IS
  'Limite de desconto sem aprovação do gerente. Zero = qualquer desconto precisa de aprovação.';

GRANT SELECT, INSERT, UPDATE, DELETE ON tab_ciosp_preco TO intranet;
GRANT USAGE, SELECT ON SEQUENCE tab_ciosp_preco_id_seq TO intranet;
