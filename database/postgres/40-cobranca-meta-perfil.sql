-- Cobranca - Metas de inadimplencia por perfil de cliente
--
-- 4 perfis (segmentos) com metas distintas:
--   Corporativo        -> 0%   (tolerancia zero)
--   Atacado            -> ate 2%
--   Assistencia Tecnica-> ate 2%
--   Varejo (longo prazo) -> 6% a 8% (faixa aceitavel)
--
-- Cada equipe (tab_cobranca_bu_equipe.equipe) eh classificada em 1 perfil.

CREATE TABLE IF NOT EXISTS tab_cobranca_meta_perfil (
    perfil           varchar(40) PRIMARY KEY,
    meta_min_pct     numeric(5,2) NOT NULL DEFAULT 0,
    meta_max_pct     numeric(5,2) NOT NULL DEFAULT 2,
    tolerancia_zero  boolean      NOT NULL DEFAULT false,
    descricao        text,
    atualizado_em    timestamp    NOT NULL DEFAULT NOW()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON tab_cobranca_meta_perfil TO intranet;

INSERT INTO tab_cobranca_meta_perfil (perfil, meta_min_pct, meta_max_pct, tolerancia_zero, descricao) VALUES
  ('Corporativo',         0.0, 0.0, true,  'Grandes clientes — tolerância zero. Qualquer inadimplência aciona alerta.'),
  ('Atacado',             0.0, 2.0, false, 'Carteira de atacado (incluindo franquias e taxas). Limite 2%.'),
  ('Assistência Técnica', 0.0, 2.0, false, 'Carteira de assistências técnicas. Limite 2%.'),
  ('Varejo',              6.0, 8.0, false, 'Carteira de longo prazo (varejo, online, digital, etc). Faixa aceitavel 6% a 8%.')
ON CONFLICT (perfil) DO NOTHING;

-- Adiciona perfil na tabela de mapeamento BU -> equipe
ALTER TABLE tab_cobranca_bu_equipe
    ADD COLUMN IF NOT EXISTS perfil varchar(40);

-- Mapeamento inicial: cada equipe -> 1 perfil. Default = Varejo (caso nao reconheca)
UPDATE tab_cobranca_bu_equipe
   SET perfil = CASE
       WHEN equipe = 'Corporativo'                                                THEN 'Corporativo'
       WHEN equipe IN ('Comercial Atacado','Franquias','Taxa de Franquia')        THEN 'Atacado'
       WHEN equipe = 'Assistência Técnica'                                        THEN 'Assistência Técnica'
       WHEN equipe IN ('Comercial Varejo','Online','Digital','Licitação','Olist',
                       'Garantia','Troca','Redigitação','Representantes',
                       'GNATUS SERVICE','(Desconhecido)')                         THEN 'Varejo'
       ELSE 'Varejo'
   END
 WHERE perfil IS NULL;

CREATE INDEX IF NOT EXISTS ix_cob_bueq_perfil ON tab_cobranca_bu_equipe (perfil);

COMMENT ON TABLE tab_cobranca_meta_perfil IS
    'Metas de inadimplencia por perfil (Corporativo/Atacado/AT/Varejo). Usado pra colorir status no dashboard de cobranca.';
COMMENT ON COLUMN tab_cobranca_bu_equipe.perfil IS
    'Perfil/segmento da equipe — referencia tab_cobranca_meta_perfil.perfil';
