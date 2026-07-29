-- NFS-e Barretos (Padrão Nacional / DPS) — controle de emissão pela intranet.
-- Cada linha = 1 tentativa de emitir a NFS-e de uma NF de serviço (SF2 série C).
-- A intranet monta o DPS (nfseXml), assina (nfseAssinatura) e envia (nfseBarretos);
-- aqui guardamos o resultado (chave/status/xml) e evitamos emissão dupla. Idempotente.

CREATE TABLE IF NOT EXISTS tab_nfse_emitida (
  id            SERIAL PRIMARY KEY,
  filial        VARCHAR(4)  NOT NULL DEFAULT '01',
  serie         VARCHAR(3)  NOT NULL DEFAULT 'C',      -- série da NF de serviço no Protheus
  doc           VARCHAR(9)  NOT NULL,                   -- F2_DOC
  cliente       VARCHAR(6)  NOT NULL,                   -- F2_CLIENTE
  loja          VARCHAR(4)  NOT NULL,                   -- F2_LOJA
  cliente_nome  VARCHAR(200),
  valor         NUMERIC(15,2),
  discriminacao TEXT,
  ctribnac      VARCHAR(12),                            -- código nacional enviado (ex.: 080201)
  ambiente      VARCHAR(12) NOT NULL DEFAULT 'restrita',-- restrita (tpAmb 2) | producao (tpAmb 1)
  status        VARCHAR(12) NOT NULL DEFAULT 'PENDENTE',-- EMITIDA | REJEITADA | ERRO | PENDENTE
  dps_id        VARCHAR(60),                            -- Id do infDPS
  nfse_chave    VARCHAR(60),                            -- chave de acesso da NFS-e
  nfse_numero   VARCHAR(30),
  dps_xml       TEXT,                                   -- DPS assinado enviado
  nfse_xml      TEXT,                                   -- NFS-e retornada (descompactada)
  retorno       JSONB,                                  -- resposta estruturada (httpStatus, erros...)
  erros         JSONB,
  writeback     VARCHAR(12) NOT NULL DEFAULT 'PENDENTE',-- PENDENTE | OK | NA — gravação da chave no Protheus (Diego)
  emitido_por   VARCHAR(120),
  emitido_em    TIMESTAMPTZ,
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Trava de emissão dupla: 1 nota só pode ter 1 registro EMITIDA/PENDENTE por
-- ambiente (o PENDENTE é a "reserva" antes de enviar — serializa a emissão e
-- impede 2 pessoas emitirem a mesma nota ao mesmo tempo). REJEITADA/ERRO ficam
-- fora do índice → permitem retry.
CREATE UNIQUE INDEX IF NOT EXISTS ux_nfse_emitida_nota
  ON tab_nfse_emitida (filial, serie, doc, cliente, loja, ambiente)
  WHERE status IN ('PENDENTE', 'EMITIDA');
CREATE INDEX IF NOT EXISTS ix_nfse_emitida_status ON tab_nfse_emitida (status);
CREATE INDEX IF NOT EXISTS ix_nfse_emitida_doc    ON tab_nfse_emitida (doc);
CREATE INDEX IF NOT EXISTS ix_nfse_emitida_criado ON tab_nfse_emitida (criado_em DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON tab_nfse_emitida TO intranet;
GRANT USAGE, SELECT ON SEQUENCE tab_nfse_emitida_id_seq TO intranet;
