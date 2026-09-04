-- NFS-e RECEBIDAS via Ambiente de Dados Nacional (ADN) da NFS-e Padrão Nacional.
-- Espelha o modelo do DF-e (tab_dfe_recebida/tab_dfe_nsu): puxa os documentos de
-- serviço do contribuinte por NSU incremental, com o A1 (mTLS), e guarda o XML.
-- Alimenta a aba "Pendências NFS-e" do Painel Fiscal (Gnatus como TOMADORA).
-- SOMENTE LEITURA no ADN. Idempotente. Perm 16001.
--
-- Contrato (validado 04/09/2026 com o nosso A1):
--   GET https://adn.nfse.gov.br/contribuintes/dfe/{NSU}?tipoNSU=DISTRIBUICAO
--   -> { StatusProcessamento, LoteDFe:[{ NSU, ChaveAcesso, TipoDocumento, ArquivoXml(gzip+base64) }] }
--   NSU incremental (devolve do NSU seguinte em diante), lote de até 50, sem maxNSU
--   no envelope — paginação para quando o lote vem com < 50 (última página).

CREATE TABLE IF NOT EXISTS tab_nfse_recebida (
  chave         VARCHAR(50) PRIMARY KEY,        -- ChaveAcesso da NFS-e (50 díg) / Id do evento
  nsu           BIGINT UNIQUE,                  -- NSU do documento na distribuição do ADN
  tipo_doc      VARCHAR(20),                    -- NFSE | evento (cancelamento etc.)
  numero        VARCHAR(20),                    -- nNFSe
  serie         VARCHAR(10),                    -- série da DPS
  emit_cnpj     VARCHAR(20),                    -- prestador (emit)
  emit_nome     VARCHAR(200),
  emit_mun      VARCHAR(10),                    -- cMun IBGE do prestador
  emit_uf       VARCHAR(2),
  emit_mun_nome VARCHAR(120),                   -- xLocEmi
  toma_cnpj     VARCHAR(20),                    -- tomador (toma) — normalmente a Gnatus
  toma_nome     VARCHAR(200),
  direcao       VARCHAR(10),                    -- recebida (somos tomador) | emitida (somos prestador)
  valor         NUMERIC(15,2),                  -- vLiq
  valor_iss     NUMERIC(15,2),                  -- vISSQN
  aliq          NUMERIC(7,4),                   -- pAliqAplic
  desc_servico  VARCHAR(500),                   -- xDescServ
  ctrib_nac     VARCHAR(20),                    -- cTribNac (item da lista nacional)
  dh_emi        TIMESTAMPTZ,                    -- DPS/dhEmi
  dh_proc       TIMESTAMPTZ,                    -- infNFSe/dhProc
  competencia   DATE,                           -- DPS/dCompet
  cstat         VARCHAR(5),                     -- cStat da NFS-e
  situacao      VARCHAR(20) NOT NULL DEFAULT 'PENDENTE',  -- workflow manual: PENDENTE | CONFERIDA
  conferido_por INTEGER,
  conferido_em  TIMESTAMPTZ,
  xml           TEXT,                            -- XML descompactado da NFS-e
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_nfser_dhemi ON tab_nfse_recebida (dh_emi DESC);
CREATE INDEX IF NOT EXISTS ix_nfser_emit  ON tab_nfse_recebida (emit_cnpj);
CREATE INDEX IF NOT EXISTS ix_nfser_dir   ON tab_nfse_recebida (direcao);
CREATE INDEX IF NOT EXISTS ix_nfser_sit   ON tab_nfse_recebida (situacao);

-- Cursor de NSU por CNPJ (nunca reconsultar do 0 sem necessidade — o ADN tem
-- limite de consumo; sempre parte do ult_nsu guardado).
CREATE TABLE IF NOT EXISTS tab_nfse_adn_nsu (
  cnpj          VARCHAR(14) PRIMARY KEY,
  ult_nsu       BIGINT NOT NULL DEFAULT 0,
  max_nsu       BIGINT,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON tab_nfse_recebida, tab_nfse_adn_nsu TO intranet;
