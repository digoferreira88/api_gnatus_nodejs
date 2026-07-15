-- Pesquisa de Pós-venda (NPS) — módulo SAC. Quando um pedido chega a estatus 99
-- (TOTALMENTE FATURADO), o scheduler cria um convite e dispara o link por
-- WhatsApp (Suri). O cliente responde numa página PÚBLICA; o sistema classifica
-- (detrator/neutro/promotor) pela pergunta NPS, guarda tudo e alimenta os
-- dashboards + a lista de detratores p/ ação (ex.: ticket no Octadesk).
-- Perm 6003 (SAC). Idempotente.

INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo)
VALUES (6003, 'SAC - Pesquisa Pós-venda (NPS)', 'SAC')
ON CONFLICT (id_permissao) DO NOTHING;

-- ===== Config (chave/valor) =====
CREATE TABLE IF NOT EXISTS tab_nps_config (
  chave          TEXT PRIMARY KEY,
  valor          JSONB NOT NULL,
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_por INTEGER
);
INSERT INTO tab_nps_config (chave, valor) VALUES
  ('classificacao', '{"detratorMax":6,"promotorMin":9}'::jsonb),   -- 0..6 detrator · 7..8 neutro · 9..10 promotor (editável CX)
  ('ativo',         'false'::jsonb),                                 -- liga/desliga o disparo automático
  ('dataInicio',    'null'::jsonb),                                  -- só pesquisa pedidos faturados A PARTIR desta data (evita backfill)
  ('expiraDias',    '30'::jsonb),
  ('mensagem',      '{"titulo":"Sua opinião é muito importante para a Gnatus","subtitulo":"Leva menos de 1 minuto — obrigado por responder!","agradecimento":"Recebemos sua resposta. Muito obrigado!"}'::jsonb)
ON CONFLICT (chave) DO NOTHING;

-- ===== Perguntas (editáveis pelo time de CX) =====
CREATE TABLE IF NOT EXISTS tab_nps_pergunta (
  id          SERIAL PRIMARY KEY,
  ordem       INTEGER NOT NULL DEFAULT 1,
  texto       TEXT NOT NULL,
  tipo        TEXT NOT NULL DEFAULT 'nps',    -- nps(0-10) | escala(1-5) | texto | opcao
  opcoes      JSONB,                           -- p/ tipo 'opcao': ["...","..."]
  obrigatoria BOOLEAN NOT NULL DEFAULT TRUE,
  e_nps       BOOLEAN NOT NULL DEFAULT FALSE,  -- pergunta que define a classificação (só 1 ativa)
  ativa       BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO tab_nps_pergunta (ordem, texto, tipo, obrigatoria, e_nps, ativa)
SELECT * FROM (VALUES
  (1, 'Em uma escala de 0 a 10, o quanto você recomendaria a Gnatus para um colega ou parceiro?', 'nps',   TRUE,  TRUE,  TRUE),
  (2, 'Qual o principal motivo da sua nota?',                                                      'texto', FALSE, FALSE, TRUE)
) v(ordem, texto, tipo, obrigatoria, e_nps, ativa)
WHERE NOT EXISTS (SELECT 1 FROM tab_nps_pergunta);

-- ===== Convites (1 por pedido faturado) =====
CREATE TABLE IF NOT EXISTS tab_nps_convite (
  id            SERIAL PRIMARY KEY,
  token         TEXT NOT NULL UNIQUE,
  pedido        VARCHAR(20) NOT NULL,
  filial        VARCHAR(4)  NOT NULL DEFAULT '01',
  cliente_cod   VARCHAR(20), cliente_loja VARCHAR(10), cliente_nome VARCHAR(200), cnpj VARCHAR(20),
  telefone      VARCHAR(20),
  nf            VARCHAR(20),
  valor_pedido  NUMERIC(15,2),
  status        VARCHAR(12) NOT NULL DEFAULT 'PENDENTE',  -- PENDENTE | ENVIADO | RESPONDIDO | ERRO | EXPIRADO
  classificacao VARCHAR(10),                              -- DETRATOR | NEUTRO | PROMOTOR
  nota_nps      INTEGER,
  canal         VARCHAR(12) NOT NULL DEFAULT 'WHATSAPP',
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  enviado_em    TIMESTAMPTZ, respondido_em TIMESTAMPTZ, expira_em TIMESTAMPTZ,
  envio_resposta JSONB,
  UNIQUE (filial, pedido)
);
CREATE INDEX IF NOT EXISTS ix_nps_convite_status ON tab_nps_convite (status, criado_em DESC);
CREATE INDEX IF NOT EXISTS ix_nps_convite_class  ON tab_nps_convite (classificacao, respondido_em DESC);

-- ===== Respostas =====
CREATE TABLE IF NOT EXISTS tab_nps_resposta (
  id            SERIAL PRIMARY KEY,
  convite_id    INTEGER NOT NULL REFERENCES tab_nps_convite(id) ON DELETE CASCADE,
  pergunta_id   INTEGER REFERENCES tab_nps_pergunta(id),
  pergunta_texto TEXT,           -- snapshot (a pergunta pode mudar depois)
  tipo          TEXT,
  nota          INTEGER, texto TEXT, opcao TEXT,
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (convite_id, pergunta_id)
);

-- ===== Ações sobre detratores =====
CREATE TABLE IF NOT EXISTS tab_nps_acao (
  id                 SERIAL PRIMARY KEY,
  convite_id         INTEGER NOT NULL REFERENCES tab_nps_convite(id) ON DELETE CASCADE,
  tipo               VARCHAR(20) NOT NULL,   -- OCTADESK | CONTATO | OUTRO
  octadesk_ticket_id TEXT, octadesk_url TEXT,
  observacao         TEXT,
  usuario_id         INTEGER REFERENCES tab_intranet_usr(id) ON DELETE SET NULL,
  usuario_nome       VARCHAR(160),
  criado_em          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_nps_acao_convite ON tab_nps_acao (convite_id, criado_em DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON tab_nps_config, tab_nps_pergunta, tab_nps_convite, tab_nps_resposta, tab_nps_acao TO intranet;
GRANT USAGE, SELECT ON SEQUENCE tab_nps_pergunta_id_seq, tab_nps_convite_id_seq, tab_nps_resposta_id_seq, tab_nps_acao_id_seq TO intranet;
