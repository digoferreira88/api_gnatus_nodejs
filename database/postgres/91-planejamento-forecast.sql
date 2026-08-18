-- Planejamento — Forecast de Vendas (FORM 7.5.1.3) automatizado na intranet.
-- Substitui a planilha de 16 abas: cada VENDEDOR lança a PREVISÃO por produto/mês;
-- o REALIZADO vem do Protheus (SF2.F2_VEND1 × SD2 × SA1 região); a intranet monta
-- o painel previsto × realizado (%atingimento) sem cópia manual nem consolidação frágil.

-- ---------------------------------------------------------------------------
-- 1) Produtos do forecast (lista-mestra, ~206 do xlsx). Único por código.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tab_forecast_produto (
  codigo     VARCHAR(30) PRIMARY KEY,
  descricao  TEXT,
  ordem      INTEGER,
  ativo      BOOLEAN DEFAULT TRUE,
  criado_em  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_forecast_produto_ordem ON tab_forecast_produto (ordem) WHERE ativo;

-- ---------------------------------------------------------------------------
-- 2) Carteiras = as "abas" do xlsx (vendedor/região). Mapeiam para código(s) de
--    vendedor Protheus (que faturam em SF2.F2_VEND1) + um filtro opcional de UF.
--    - vendedor_cods: CSV de A3_COD (um vendedor pode ter +1 código).
--    - ufs:           CSV de UFs (vazio = todas). É como se separa CÁSSIO(PR/SC/RS)
--                     e ROSSANDRO(NORTE/CO/NE): mesmo vendedor, UFs diferentes.
--    - usuario_id:    usuário da intranet que EDITA essa carteira (self-service).
--    - consolidar:    entra na soma do total geral? (FALSE nas abas "detalhe" p/ não
--                     dobrar: ex. CÁSSIO PR/SC/RS = detalhe de CÁSSIO TOTAL).
--    ⚠️ O de-para nome→vendedor_cods+ufs deve ser CONFIRMADO com o Planejamento;
--    aqui a estrutura é configurável (via tela de gestão, perm 18002).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tab_forecast_carteira (
  id            SERIAL PRIMARY KEY,
  nome          TEXT NOT NULL,
  vendedor_cods TEXT,                    -- CSV de A3_COD (ex.: '000018' ou '0100,0101')
  ufs           TEXT,                    -- CSV de UFs (ex.: 'PR' | 'AC,AP,AM,PA,RO,RR,TO') — vazio = todas
  usuario_id    INTEGER,                 -- dono/editor (self-service). NULL = só gestão edita
  consolidar    BOOLEAN DEFAULT TRUE,    -- entra no total consolidado?
  ordem         INTEGER,
  ativo         BOOLEAN DEFAULT TRUE,
  criado_em     TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_forecast_carteira_user ON tab_forecast_carteira (usuario_id) WHERE ativo;

-- ---------------------------------------------------------------------------
-- 3) Previsão: qtd por (ano, carteira, produto, mês). Editável pelo dono da carteira.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tab_forecast_previsao (
  id             BIGSERIAL PRIMARY KEY,
  ano            INTEGER NOT NULL,
  carteira_id    INTEGER NOT NULL REFERENCES tab_forecast_carteira(id) ON DELETE CASCADE,
  produto_cod    VARCHAR(30) NOT NULL,
  mes            SMALLINT NOT NULL CHECK (mes BETWEEN 1 AND 12),
  qtd            INTEGER NOT NULL DEFAULT 0,
  atualizado_por INTEGER,
  atualizado_em  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (ano, carteira_id, produto_cod, mes)
);
CREATE INDEX IF NOT EXISTS ix_forecast_prev_ano_cart ON tab_forecast_previsao (ano, carteira_id);
CREATE INDEX IF NOT EXISTS ix_forecast_prev_ano_prod ON tab_forecast_previsao (ano, produto_cod);

-- ---------------------------------------------------------------------------
-- 4) Config por ano: revisão (rótulo ISO) + se está ABERTO para edição.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tab_forecast_config (
  ano       INTEGER PRIMARY KEY,
  rev       TEXT,                        -- ex.: 'MAR26'
  data_rev  DATE,
  aberto    BOOLEAN DEFAULT TRUE,        -- FALSE = congela a previsão (só leitura)
  criado_em TIMESTAMPTZ DEFAULT NOW()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON
  tab_forecast_produto, tab_forecast_carteira, tab_forecast_previsao, tab_forecast_config TO intranet;
GRANT USAGE, SELECT ON SEQUENCE
  tab_forecast_carteira_id_seq, tab_forecast_previsao_id_seq TO intranet;

-- ---------------------------------------------------------------------------
-- Permissões (bloco 18xxx — Planejamento; 17xxx = Simulador já usado).
--   18001 = Forecast (vendedor): vê/edita SÓ as carteiras do seu usuario_id.
--   18002 = Forecast Gestão: vê todas as carteiras, dashboard e admin (carteiras/produtos).
-- ---------------------------------------------------------------------------
INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo) VALUES
  (18001, 'Planejamento - Forecast (vendedor)', 'Planejamento'),
  (18002, 'Planejamento - Forecast Gestão / Dashboard', 'Planejamento')
ON CONFLICT (id_permissao) DO UPDATE SET nome = EXCLUDED.nome, modulo = EXCLUDED.modulo;

INSERT INTO tab_intranet_usr_permissoes (id_user, id_permissao, matricula)
SELECT u.id, p.id_permissao, u.matricula
  FROM tab_intranet_usr u CROSS JOIN (VALUES (18001), (18002)) AS p(id_permissao)
 WHERE u.email = 'admin@gnatus.com.br'
ON CONFLICT (id_user, id_permissao) DO NOTHING;
