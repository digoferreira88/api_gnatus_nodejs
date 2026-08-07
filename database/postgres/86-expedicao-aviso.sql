-- Pré-Expedição / Confirmação de Recebimento.
-- Quando um pedido entra na separação de estoque (pedidos_estatus estatus_cod=50),
-- dispara um WhatsApp (Suri) ao cliente com um link para CONFIRMAR / RECUSAR /
-- REAGENDAR o recebimento. As respostas ficam pra a expedição acompanhar antes da
-- coleta. Espelha o padrão do NPS (tab_nps_convite/config). 100% PostgreSQL.

-- Config chave/valor (liga-desliga + data de corte + mensagem), igual tab_nps_config.
CREATE TABLE IF NOT EXISTS tab_expedicao_config (
  chave TEXT PRIMARY KEY,
  valor JSONB
);
INSERT INTO tab_expedicao_config (chave, valor) VALUES
  ('ativo',      'false'::jsonb),   -- só dispara quando true (e com SURI_TPL_EXPEDICAO no .env)
  ('dataInicio', 'null'::jsonb),    -- 'YYYY-MM-DD' — piso por C5_EMISSAO (evita blast de histórico no go-live)
  ('expiraDias', '15'::jsonb),      -- link expira depois de N dias
  ('mensagem',   '{}'::jsonb)       -- textos da página pública (abertura/agradecimento)
ON CONFLICT (chave) DO NOTHING;

-- Log de disparo + resposta (espelho de tab_nps_convite).
CREATE TABLE IF NOT EXISTS tab_expedicao_aviso (
  id             SERIAL PRIMARY KEY,
  token          TEXT UNIQUE NOT NULL,
  filial         VARCHAR(4)  NOT NULL DEFAULT '01',
  pedido         VARCHAR(20) NOT NULL,
  cliente_cod    VARCHAR(10),
  cliente_loja   VARCHAR(4),
  cliente_nome   TEXT,
  cnpj           VARCHAR(20),
  telefone       VARCHAR(20),
  bu_cod         VARCHAR(10),
  bu_nome        TEXT,
  vendedor_cod   VARCHAR(10),
  vendedor_nome  TEXT,
  valor_pedido   NUMERIC(15,2),
  -- disparo
  status         VARCHAR(12) NOT NULL DEFAULT 'PENDENTE',  -- PENDENTE|ENVIADO|RESPONDIDO|ERRO|EXPIRADO
  canal          VARCHAR(12) DEFAULT 'WHATSAPP',
  criado_em      TIMESTAMPTZ DEFAULT NOW(),
  enviado_em     TIMESTAMPTZ,
  expira_em      TIMESTAMPTZ,
  envio_resposta JSONB,
  -- resposta do cliente (link público)
  resposta       VARCHAR(12),   -- CONFIRMADO | RECUSADO | REAGENDAR
  nova_data      DATE,          -- preenchida só no REAGENDAR
  observacao     TEXT,
  respondido_em  TIMESTAMPTZ,
  -- tratativa da expedição
  tratado        BOOLEAN DEFAULT FALSE,
  tratado_por    INTEGER,
  tratado_em     TIMESTAMPTZ,
  tratado_obs    TEXT,
  CONSTRAINT uq_exp_aviso_filial_pedido UNIQUE (filial, pedido)
);
CREATE INDEX IF NOT EXISTS ix_exp_aviso_status ON tab_expedicao_aviso (status, criado_em DESC);
CREATE INDEX IF NOT EXISTS ix_exp_aviso_resp   ON tab_expedicao_aviso (resposta) WHERE resposta IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_exp_aviso_aberto ON tab_expedicao_aviso (tratado) WHERE resposta IS NOT NULL AND resposta <> 'CONFIRMADO';

GRANT SELECT, INSERT, UPDATE, DELETE ON tab_expedicao_aviso, tab_expedicao_config TO intranet;
GRANT USAGE, SELECT ON SEQUENCE tab_expedicao_aviso_id_seq TO intranet;

-- Permissão do acompanhamento (expedição). O link público é anônimo (sem permissão).
INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo)
VALUES (12003, 'Expedição - Confirmação de Recebimento', 'Expedição')
ON CONFLICT (id_permissao) DO UPDATE SET nome = EXCLUDED.nome, modulo = EXCLUDED.modulo;

INSERT INTO tab_intranet_usr_permissoes (id_user, id_permissao, matricula)
SELECT u.id, 12003, u.matricula FROM tab_intranet_usr u WHERE u.email = 'admin@gnatus.com.br'
ON CONFLICT (id_user, id_permissao) DO NOTHING;
