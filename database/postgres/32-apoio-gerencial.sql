-- Apoio Gerencial — Gerador de Apresentacoes
-- Salva apresentacoes geradas pela IA (Claude) a partir de planilhas/CSV.
-- O JSON `dados` contem: titulo, subtitulo, KPIs, narrativa, graficos e
-- proximos passos — exatamente como retornados pela API do Claude.

CREATE TABLE IF NOT EXISTS tab_apoio_apresentacao (
    id              SERIAL PRIMARY KEY,
    id_user         int REFERENCES tab_intranet_usr(id) ON DELETE SET NULL,
    nome_arquivo    varchar(200),
    titulo          varchar(200),
    subtitulo       varchar(300),
    -- Estatisticas brutas extraidas da planilha (cols, tipos, ranges, samples)
    perfil          jsonb,
    -- Resposta estruturada da IA (kpis, graficos, narrativa, conclusao, ...)
    dados           jsonb,
    modelo_ia       varchar(60),         -- ex 'claude-sonnet-4-6'
    tokens_in       int,
    tokens_out      int,
    custo_estimado  numeric(10, 4),      -- USD
    criado_em       timestamp NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_apoio_apre_user ON tab_apoio_apresentacao (id_user, criado_em DESC);
CREATE INDEX IF NOT EXISTS ix_apoio_apre_data ON tab_apoio_apresentacao (criado_em DESC);

-- Permissao 5001 — primeira da faixa 5xxx (Apoio Gerencial)
INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo) VALUES
  (5001, 'Apoio Gerencial - Gerador de Apresentacoes', 'Apoio Gerencial')
ON CONFLICT (id_permissao) DO UPDATE
   SET nome = EXCLUDED.nome, modulo = EXCLUDED.modulo;
