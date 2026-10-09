-- 130 — Portal do cliente: espelho publicado pela intranet — 09/10/2026
--
-- O portal do cliente NÃO pode estar na intranet (decisão do usuário) e não vai
-- consultar o Protheus nem esta base. A intranet monta aqui o conjunto do que o
-- cliente pode ver e EMPURRA para o portal; o portal só lê a cópia que recebeu.
-- Assim um problema no site público não alcança o ERP.
--
-- O que entra: títulos de VENDA (natureza 10101/10201), filial 01, sem RA/NCC —
-- os em aberto e os liquidados nos últimos 12 meses, para o cliente ver histórico
-- sem a gente publicar a vida inteira dele.
--
-- Medido em 09/10 para dimensionar: 1.828 títulos em aberto têm boleto (R$ 3,93 mi)
-- e 11.277 NÃO têm (R$ 30,77 mi). Ou seja, a maior parte do que o cliente vê na
-- fase 1 é "sem boleto — falar com a cobrança", até o Pix entrar.

CREATE TABLE IF NOT EXISTS tab_portal_espelho (
  id               SERIAL PRIMARY KEY,
  -- chave estável do título; é por ela que o portal faz upsert
  ref              VARCHAR(80) NOT NULL UNIQUE,

  cliente_doc      VARCHAR(14) NOT NULL,          -- só dígitos: é o login do portal
  cliente_cod      VARCHAR(10),
  cliente_loja     VARCHAR(4),
  cliente_nome     VARCHAR(200),
  -- O portal precisa do contato para mandar o código de acesso. Vai o mínimo:
  -- telefone e e-mail de quem tem título. Na tela os dois aparecem mascarados.
  contato_telefone VARCHAR(20),
  contato_email    VARCHAR(120),

  prefixo          VARCHAR(3),
  numero           VARCHAR(12) NOT NULL,
  parcela          VARCHAR(4),
  tipo             VARCHAR(4),
  emissao          DATE,
  vencimento       DATE,
  valor            NUMERIC(15,2) NOT NULL DEFAULT 0,
  saldo            NUMERIC(15,2) NOT NULL DEFAULT 0,

  situacao         VARCHAR(10) NOT NULL,          -- pago | a_vencer | vencido
  data_pagamento   DATE,
  valor_pago       NUMERIC(15,2),

  tem_boleto       BOOLEAN NOT NULL DEFAULT FALSE,
  banco            VARCHAR(3),
  nosso_numero     VARCHAR(20),                   -- já no formato que o banco imprime
  linha_digitavel  VARCHAR(60),
  codigo_barras    VARCHAR(50),

  -- Decisão do usuário: 2ª via de VENCIDO é com o financeiro, não self-service.
  -- `motivo_2via` é o texto que o portal mostra quando o botão não aparece.
  pode_2via        BOOLEAN NOT NULL DEFAULT FALSE,
  motivo_2via      VARCHAR(80),

  atualizado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  publicado_em     TIMESTAMPTZ                    -- NULL = ainda não foi para o portal
);

CREATE INDEX IF NOT EXISTS ix_portal_espelho_doc  ON tab_portal_espelho (cliente_doc);
CREATE INDEX IF NOT EXISTS ix_portal_espelho_pub  ON tab_portal_espelho (publicado_em NULLS FIRST, atualizado_em);
CREATE INDEX IF NOT EXISTS ix_portal_espelho_sit  ON tab_portal_espelho (situacao);

COMMENT ON TABLE tab_portal_espelho IS
  'O que o cliente pode ver no portal. A intranet escreve; o portal recebe cópia. Nunca o contrário.';
COMMENT ON COLUMN tab_portal_espelho.pode_2via IS
  'Só true para boleto registrado, ainda não vencido e não cedido a fundo (FIDC). Vencido é tratado pelo financeiro.';

-- Histórico de cada publicação: sem isso não dá para saber o que o portal recebeu
-- quando um cliente reclamar de um número diferente do que está no ERP.
CREATE TABLE IF NOT EXISTS tab_portal_publicacao (
  id           SERIAL PRIMARY KEY,
  gerado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  titulos      INTEGER NOT NULL DEFAULT 0,
  clientes     INTEGER NOT NULL DEFAULT 0,
  com_boleto   INTEGER NOT NULL DEFAULT 0,
  enviados     INTEGER NOT NULL DEFAULT 0,
  status       VARCHAR(12) NOT NULL DEFAULT 'gerado',   -- gerado | enviado | erro | inerte
  destino      VARCHAR(200),
  erro         TEXT,
  duracao_ms   INTEGER,
  por          INTEGER
);

CREATE INDEX IF NOT EXISTS ix_portal_publicacao ON tab_portal_publicacao (gerado_em DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON tab_portal_espelho, tab_portal_publicacao TO intranet;
GRANT USAGE, SELECT ON SEQUENCE tab_portal_espelho_id_seq, tab_portal_publicacao_id_seq TO intranet;
