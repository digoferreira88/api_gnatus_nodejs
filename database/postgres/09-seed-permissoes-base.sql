-- Seed completo de TODAS as permissões usadas pelo sidebar/routes da Intranet.
-- Idempotente: ON CONFLICT DO NOTHING — pode rodar várias vezes sem efeito.

INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo) VALUES
  (   0, 'Administrador (acesso total)',           'Sistema'),
  (1026, 'Tecnologia - Gerenciamento de Permissões', 'Tecnologia'),
  (1027, 'Tecnologia - Termo de Responsabilidade',   'Tecnologia'),
  (1028, 'Tecnologia - Gestão de Usuários',          'Tecnologia'),
  (1029, 'Tecnologia - Provisionamento de Usuários', 'Tecnologia'),
  (1030, 'Tecnologia - Cobrança WhatsApp (automação)', 'Tecnologia'),
  (2001, 'Faturamento - Ranking de Vendedores',      'Faturamento'),
  (2002, 'Faturamento - Relatório de Faturamento',   'Faturamento'),
  (3001, 'Planejamento - Disponibilidade',           'Planejamento'),
  (4001, 'Compras - Solicitações de Compra',         'Compras'),
  (4002, 'Compras - Pedidos de Compra',              'Compras'),
  (5001, 'Perfil - Reserva de Salas',                'Perfil'),
  (6001, 'SAC - Consulta de Cliente',                'SAC'),
  (6002, 'SAC - Supervisor',                         'SAC'),
  (7001, 'Perfil - Cofre de Senhas',                 'Perfil'),
  (8001, 'Financeiro - Contas a Pagar',              'Financeiro'),
  (8002, 'Financeiro - Contas a Receber',            'Financeiro'),
  (8004, 'Financeiro - Fluxo de Caixa',              'Financeiro'),
  (8003, 'Cobrança - Acesso',                        'Cobrança'),
  (9001, 'Cobrança - Painel',                        'Cobrança'),
  (9002, 'Cobrança - Ação',                          'Cobrança'),
  (9003, 'Cobrança - Minhas Ações',                  'Cobrança'),
  (9004, 'Cobrança - Envio WhatsApp (curadoria)',    'Cobrança'),
  (10001, 'Gerência - DRE Gerencial',                'Gerência'),
  (11001, 'Controladoria - Estoque',                 'Controladoria'),
  (11002, 'Controladoria - Custo de Produto',        'Controladoria'),
  (11003, 'Controladoria - Poder de Terceiros',      'Controladoria'),
  (12001, 'Expedição - Notas a Expedir',             'Expedição'),
  (12002, 'Expedição - Borderô de Etiquetagem',      'Expedição'),
  (13001, 'Compras - Aprovador (SC/PC)',             'Compras')
ON CONFLICT (id_permissao) DO UPDATE
   SET nome   = EXCLUDED.nome,
       modulo = EXCLUDED.modulo;

-- Resumo
SELECT modulo, COUNT(*) AS total
  FROM tab_intranet_permissoes
 GROUP BY modulo
 ORDER BY modulo;
