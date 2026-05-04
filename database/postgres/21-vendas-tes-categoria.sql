-- Vendas - Saidas Diversas
--
-- Tabela de configuracao das TES (categorias 'acompanhar' e 'diversos').
-- Conteudo migrado da intranet antiga (protheusHelpers.php: TES_acompanhar/TES_diversos).
-- Editar livremente via SQL ou UI futura.

INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo)
VALUES (2003, 'Vendas - Saidas Diversas', 'Vendas')
ON CONFLICT (id_permissao) DO NOTHING;

INSERT INTO tab_intranet_usr_permissoes (id_user, id_permissao, matricula)
SELECT u.id, 2003, u.matricula FROM tab_intranet_usr u WHERE u.email = 'admin@gnatus.com.br'
ON CONFLICT (id_user, id_permissao) DO NOTHING;

CREATE TABLE IF NOT EXISTS tab_vendas_tes_categoria (
    id          SERIAL PRIMARY KEY,
    tes         varchar(10) NOT NULL,
    descricao   varchar(200) NOT NULL,
    categoria   varchar(20) NOT NULL,    -- 'acompanhar' | 'diversos'
    ativo       boolean NOT NULL DEFAULT true,
    UNIQUE (tes, categoria)
);
CREATE INDEX IF NOT EXISTS ix_vendas_tes_cat ON tab_vendas_tes_categoria (categoria, ativo);

-- Seed: TES_acompanhar (4)
INSERT INTO tab_vendas_tes_categoria (tes, descricao, categoria) VALUES
  ('538', 'RETORNO DE CONSERTO ( APENAS MOVIMENTO FISCAL)',                  'acompanhar'),
  ('546', 'REMESSA PARA COMODATO ( FAZER CONTRATO DE COMODATO)',             'acompanhar'),
  ('540', 'REMESSA PARA DEMONSTRACAO',                                       'acompanhar'),
  ('559', 'REMESSA PARA DEMONSTRACAO NMOVEST',                               'acompanhar')
ON CONFLICT (tes, categoria) DO NOTHING;

-- Seed: TES_diversos (7)
INSERT INTO tab_vendas_tes_categoria (tes, descricao, categoria) VALUES
  ('539', 'REPOSICAO DE MERCADORIA',                                          'diversos'),
  ('543', 'GARANTIA SEM CALCULO DE ICMS E IPI',                               'diversos'),
  ('585', 'GARANTIA COM CALCULO DE ICMS E IPI',                               'diversos'),
  ('566', 'BONIFICACAO OU BRINDE',                                            'diversos'),
  ('595', 'REMESSA DE MERCADORIA PARA EXPOSICAO / FEIRA',                     'diversos'),
  ('606', 'REMESSA PARA VENDA FORA DO ESTABELECIMENTO',                       'diversos'),
  ('607', 'REMESSA PARA VENDA FORA DO ESTABELECIMENTO ST (COMPUTADOR)',       'diversos')
ON CONFLICT (tes, categoria) DO NOTHING;
