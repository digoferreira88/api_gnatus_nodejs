// Testes do envio do pedido do CIOSP ao Protheus (services/ciospProtheusEnvio.js):
// montagem do JSON do PedidoVenda/incluir, leitura da resposta e estado do envio.
// Rodar:  npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../services/ciospProtheusEnvio');

const P = { id: 123, edicao: 'CIOSP 2027', numero: 45, cliente_doc: '45282860848', cliente_nome: 'Vitória Bueno Nascimento',
  cliente_rg_ie: '12.345.678-9', cliente_email: 'c@x.com', cliente_fone: '', cliente_celular: '+55 (13) 99730-6455',
  cliente_cep: '11700-000', cliente_endereco: 'Rua Exemplo, 100', cliente_bairro: 'Centro', cliente_cidade: 'Praia Grande',
  cliente_uf: 'SP', frete_valor: '0', acrescimo_norte: '0', entrega_parcial: false, cliente_genero: 'F', cliente_nascimento: '1990-05-17' };
const IT = [{ seq: 1, produto: '005796', descricao: 'G2', quantidade: '1.000', preco: '2427.86' }];
const ESC = { genero: 'F', nascimento: '1990-05-17', cod_mun: '41000', bu: 'COV', vendedor: '000091', condicao: '409',
  forma_pagto: '3', cartao_autenticacao: '', transportadora: '000001', tipo_frete: 'C', fat_parcial: 'N', mensagem: '', tes: { 1: '530' } };

test('id_externo é 700.000 + id', () => assert.equal(E.idExterno(123), 700123));

test('condição por parcelas: 400 em 10x = 409; fixa ignora parcelas', () => {
  assert.equal(E.condicaoProposta({ protheus_condicao: '400', protheus_condicao_parcelada: true }, 10), '409');
  assert.equal(E.condicaoProposta({ protheus_condicao: '400', protheus_condicao_parcelada: true }, null), '400');
  assert.equal(E.condicaoProposta({ protheus_condicao: '001', protheus_condicao_parcelada: false }, 10), '001');
  assert.equal(E.condicaoProposta({ protheus_condicao: null }, 3), null);
  assert.equal(E.condicaoProposta({ protheus_condicao: '995', protheus_condicao_parcelada: true }, 10), null);
});

test('separarFone tira +55 e zero e separa o DDD', () => {
  assert.deepEqual(E.separarFone('+55 (13) 99730-6455'), { ddd: '13', numero: '997306455' });
  assert.deepEqual(E.separarFone('013 3333-4444'), { ddd: '13', numero: '33334444' });
  assert.deepEqual(E.separarFone('3333-4444'), { ddd: '', numero: '33334444' });
  assert.deepEqual(E.separarFone(''), { ddd: '', numero: '' });
});

test('nome reduzido: até 20 sem partir palavra, sem acento', () => {
  assert.equal(E.nomeReduzido('Vitória Bueno Nascimento'), 'VITORIA BUENO');
  assert.equal(E.nomeReduzido('Odontoclinicaespecializadaltda'), 'ODONTOCLINICAESPECIA');
});

test('data do node-pg (meia-noite local) não volta um dia', () => {
  assert.equal(E.dataIso(new Date(1990, 4, 17)), '1990-05-17');
  assert.equal(E.dataIso('1990-05-17T03:00:00.000Z'), '1990-05-17');
  assert.equal(E.dataIso(null), '');
  const env = E.montarEnvio({ pedido: { ...P, cliente_nascimento: new Date(1990, 4, 17) }, itens: IT, escolhas: { ...ESC, nascimento: '' } });
  assert.equal(env.cliente.data_nascimento, '1990-05-17');
});

test('montarEnvio: PF, celular cobre o telefone vazio, preço e TES do item', () => {
  const env = E.montarEnvio({ pedido: P, itens: IT, escolhas: ESC, simular: false, usuario: 'joana.silva' });
  assert.equal(env.filial, '01');
  assert.equal(env.simular, false);
  assert.equal(env.id_externo, 700123);
  assert.equal(env.usuario, 'joana.silva');
  assert.equal(env.origem, 'CIOSP 2027 - pedido 45');
  assert.equal(env.cliente.cgc, '45282860848');
  assert.equal(env.cliente.codigo, ''); assert.equal(env.cliente.loja, '');
  assert.equal(env.cliente.pessoa, 'F'); assert.equal(env.cliente.genero, 'F');
  assert.equal(env.cliente.nome, 'VITORIA BUENO NASCIMENTO'); assert.equal(env.cliente.nome_reduzido, 'VITORIA BUENO');
  assert.equal(env.cliente.rg, '12.345.678-9'); assert.equal(env.cliente.ie, '');
  assert.deepEqual([env.cliente.ddd, env.cliente.telefone], ['13', '997306455']);
  assert.deepEqual([env.cliente.ddd_celular, env.cliente.celular], ['13', '997306455']);
  assert.equal(env.cliente.cep, '11700000'); assert.equal(env.cliente.municipio, 'PRAIA GRANDE');
  assert.equal(env.cliente.cod_mun, '41000'); assert.equal(env.cliente.uf, 'SP');
  assert.equal(env.cliente.data_nascimento, '1990-05-17');
  assert.equal(env.pedido.tipo_gnatus, 'COV'); assert.equal(env.pedido.vendedor, '000091');
  assert.equal(env.pedido.condicao, '409'); assert.equal(env.pedido.forma_pagto, '3');
  assert.equal(env.pedido.transportadora, '000001'); assert.equal(env.pedido.tipo_frete, 'C');
  assert.equal(env.pedido.frete, 0); assert.equal(env.pedido.despesa, 0); assert.equal(env.pedido.fat_parcial, 'N');
  assert.deepEqual(env.pedido.itens, [{ item: '01', produto: '005796', quantidade: 1, preco: 2427.86, tes: '530' }]);
  assert.equal(env.pedido.mensagem_nota, 'CIOSP 2027 - pedido 45');
});

test('montarEnvio: cliente já resolvido vai com código e loja; mensagem do ADM vem depois', () => {
  const env = E.montarEnvio({ pedido: { ...P, cliente_cod: '015000', cliente_loja: '01' }, itens: IT,
    escolhas: { ...ESC, cliente_codigo: '015000', cliente_loja: '01', mensagem: 'entregar na clínica' } });
  assert.equal(env.cliente.codigo, '015000'); assert.equal(env.cliente.loja, '01');
  assert.equal(env.pedido.mensagem_nota, 'CIOSP 2027 - pedido 45 - entregar na clinica');
  const outra = E.montarEnvio({ pedido: { ...P, cliente_cod: '015000', cliente_loja: '01' }, itens: IT,
    escolhas: { ...ESC, cliente_codigo: '015000', cliente_loja: '02' } });
  assert.equal(outra.cliente.loja, '02');
});

test('montarEnvio: frete e acréscimo da Amazônia em reais', () => {
  const env = E.montarEnvio({ pedido: { ...P, frete_valor: '150.5', acrescimo_norte: '72.84' }, itens: IT, escolhas: ESC });
  assert.equal(env.pedido.frete, 150.5); assert.equal(env.pedido.despesa, 72.84);
});

test('montarEnvio: telefone cobre o celular vazio', () => {
  const env = E.montarEnvio({ pedido: { ...P, cliente_fone: '(11) 3333-4444', cliente_celular: '' }, itens: IT, escolhas: ESC });
  assert.deepEqual([env.cliente.ddd_celular, env.cliente.celular], ['11', '33334444']);
});

test('montarEnvio: PJ vai com gênero E, IE só dígitos e ISENTO vazio', () => {
  const pj = { ...P, cliente_doc: '12345678000199', cliente_rg_ie: '123.456.789.110' };
  const env = E.montarEnvio({ pedido: pj, itens: IT, escolhas: ESC });
  assert.equal(env.cliente.pessoa, 'J');
  assert.equal(env.cliente.genero, 'E');
  assert.equal(env.cliente.ie, '123456789110'); assert.equal(env.cliente.rg, '');
  assert.equal(E.montarEnvio({ pedido: { ...pj, cliente_rg_ie: 'ISENTO' }, itens: IT, escolhas: ESC }).cliente.ie, '');
});

test('montarEnvio: simular e itens na ordem de seq', () => {
  const env = E.montarEnvio({ pedido: P, simular: true, escolhas: { ...ESC, tes: { 1: '530', 2: '531' } },
    itens: [{ seq: 2, produto: '005797', quantidade: '2', preco: '10' }, { seq: 1, produto: '005796', quantidade: '1', preco: '5' }] });
  assert.equal(env.simular, true);
  assert.deepEqual(env.pedido.itens.map(i => [i.item, i.produto, i.tes]), [['01', '005796', '530'], ['02', '005797', '531']]);
});

test('interpretarResposta: cada linha da tabela', () => {
  const ok = { status: 'CRIADO', pedido: '98765', cliente: { codigo: '015432', loja: '01', criado: true }, total: 2427.86, total_mercadoria: 2382.73 };
  const c = E.interpretarResposta({ http: 200, corpo: ok });
  assert.equal(c.resultado, 'criado'); assert.equal(c.pedido, '098765');
  assert.deepEqual(c.cliente, { codigo: '015432', loja: '01', criado: true });
  assert.equal(c.total, 2427.86); assert.equal(c.total_mercadoria, 2382.73); assert.equal(c.simulado, false);
  assert.equal(E.interpretarResposta({ http: 200, corpo: { ...ok, status: 'JA_EXISTIA' } }).resultado, 'ja_existia');
  const rej = E.interpretarResposta({ http: 422, corpo: { status: 'REJEITADO', inconsistencias: [{ etapa: 'pedido', item: '01', campo: 'C6_TES', mensagem: 'TES bloqueada' }] } });
  assert.equal(rej.resultado, 'recusado'); assert.equal(rej.mensagem, 'TES bloqueada');
  assert.deepEqual(rej.inconsistencias, [{ etapa: 'pedido', item: '01', campo: 'C6_TES', mensagem: 'TES bloqueada' }]);
  assert.equal(E.interpretarResposta({ http: 409, corpo: { status: 'EM_ANDAMENTO' } }).resultado, 'incerto');
  assert.equal(E.interpretarResposta({ http: 503, corpo: null }).resultado, 'sem_licenca');
  assert.equal(E.interpretarResposta({ http: 500, corpo: null }).resultado, 'incerto');
  assert.equal(E.interpretarResposta({ http: 0, corpo: null, erro: 'TIMEOUT' }).resultado, 'incerto');
  assert.equal(E.interpretarResposta({ http: 0, corpo: null, erro: 'REDE' }).resultado, 'incerto');
  assert.equal(E.interpretarResposta({ http: 200, corpo: { status: 'CRIADO' } }).resultado, 'incerto');
  const sim = E.interpretarResposta({ http: 200, corpo: { status: 'CRIADO', simulado: true, total: 10 }, simular: true });
  assert.equal(sim.resultado, 'criado'); assert.equal(sim.simulado, true); assert.equal(sim.pedido, null);
  const cfg = E.interpretarResposta({ http: 0, corpo: null, erro: 'CONFIG' });
  assert.equal(cfg.resultado, 'recusado'); assert.equal(cfg.mensagem, 'API do Protheus não configurada no servidor.');
});

test('interpretarResposta: recusa sem lista e mensagens do incerto e da licença', () => {
  const r = E.interpretarResposta({ http: 422, corpo: { status: 'REJEITADO' } });
  assert.deepEqual(r.inconsistencias, []);
  assert.ok(r.mensagem);
  assert.equal(E.interpretarResposta({ http: 500, corpo: null }).mensagem, E.MENSAGEM.incerto);
  assert.equal(E.interpretarResposta({ http: 503, corpo: null }).mensagem, E.MENSAGEM.sem_licenca);
  assert.equal(E.MENSAGEM.incerto, 'Não deu para confirmar. Tente de novo: o Protheus não duplica o pedido.');
});

test('estado do envio a partir do resultado', () => {
  assert.equal(E.estadoEnvio('criado'), 'criado');
  assert.equal(E.estadoEnvio('ja_existia'), 'criado');
  assert.equal(E.estadoEnvio('recusado'), 'recusado');
  assert.equal(E.estadoEnvio('sem_licenca'), 'incerto');
  assert.equal(E.estadoEnvio('incerto'), 'incerto');
});

test('envio travado só com enviando há menos de 4 minutos', () => {
  const agora = new Date('2027-01-28T12:00:00Z');
  assert.equal(E.envioTravado({ protheus_envio: 'enviando', protheus_envio_em: new Date('2027-01-28T11:57:00Z') }, agora), true);
  assert.equal(E.envioTravado({ protheus_envio: 'enviando', protheus_envio_em: new Date('2027-01-28T11:55:59Z') }, agora), false);
  assert.equal(E.envioTravado({ protheus_envio: 'incerto', protheus_envio_em: agora }, agora), false);
});

// ---------------------------------------------------------------- correções da revisão final

test('montarEnvio: código e loja só das escolhas (cliente novo não herda o código antigo do pedido)', () => {
  const env = E.montarEnvio({ pedido: { ...P, cliente_cod: '015000', cliente_loja: '01' }, itens: IT, escolhas: { ...ESC, cliente_codigo: '', cliente_loja: '' } });
  assert.equal(env.cliente.codigo, ''); assert.equal(env.cliente.loja, '');
});

test('mensagem da nota e origem vão em ASCII (o Protheus quebra UTF-8)', () => {
  const env = E.montarEnvio({ pedido: P, itens: IT, escolhas: { ...ESC, mensagem: 'Entregar após às 14h · portão 2' } });
  assert.equal(env.pedido.mensagem_nota, 'CIOSP 2027 - pedido 45 - Entregar apos as 14h - portao 2');
  assert.ok(/^[ -~]*$/.test(env.origem));
});

test('faixa do id_externo pode ser outra (teste no REST do Diego)', () => {
  assert.equal(E.idExterno(123, 790000), 790123);
  assert.equal(E.montarEnvio({ pedido: P, itens: IT, escolhas: ESC, faixa: 790000 }).id_externo, 790123);
  assert.equal(E.montarEnvio({ pedido: P, itens: IT, escolhas: ESC }).id_externo, 700123);
});

test('resposta com simulado diferente do pedido vira incerto (envio real × resposta simulada)', () => {
  const r = E.interpretarResposta({ http: 200, corpo: { status: 'CRIADO', simulado: true, pedido: '' }, simular: false });
  assert.equal(r.resultado, 'incerto');
  assert.match(r.mensagem, /simulado=sim para simular=não/);
});

test('simulação que volta com pedido real vira incerto com o nº', () => {
  const r = E.interpretarResposta({ http: 200, corpo: { status: 'CRIADO', simulado: false, pedido: '98765' }, simular: true });
  assert.equal(r.resultado, 'incerto');
  assert.equal(r.pedido, '098765');
  assert.match(r.mensagem, /098765/);
});

test('4xx do endpoint é recusa (nada criado) com a mensagem do corpo', () => {
  const r = E.interpretarResposta({ http: 400, corpo: { INCONSISTENCIAS: [{ mensagem: 'Condicao invalida' }] } });
  assert.equal(r.resultado, 'recusado'); assert.equal(r.mensagem, 'Condicao invalida');
  const n = E.interpretarResposta({ http: 404, corpo: null });
  assert.equal(n.resultado, 'recusado'); assert.match(n.mensagem, /HTTP 404/);
  assert.equal(E.interpretarResposta({ http: 401, corpo: { message: 'unauthorized' } }).resultado, 'recusado');
  assert.equal(E.interpretarResposta({ http: 409, corpo: { status: 'EM_ANDAMENTO' } }).resultado, 'incerto');
});

test('pedido do Protheus de outro CPF/CNPJ não é adotado; já existia avisa', () => {
  assert.deepEqual(E.decidirAdocao({ resultado: 'criado', pedido: '098765', conferido: 'ok' }), { adotar: true, aviso: null });
  assert.deepEqual(E.decidirAdocao({ resultado: 'ja_existia', pedido: '098765', conferido: 'ok' }), { adotar: true,
    aviso: 'O Protheus já tinha este pedido (tentativa anterior): as escolhas desta tentativa podem não ter sido aplicadas. Confira o pedido 098765 no Protheus.' });
  const d = E.decidirAdocao({ resultado: 'ja_existia', pedido: '098765', conferido: 'divergente' });
  assert.equal(d.adotar, false);
  assert.equal(d.mensagem, 'O pedido 098765 do Protheus é de outro CPF/CNPJ: peça para excluí-lo no Protheus e tente de novo.');
});

test('faixa do ambiente: CIOSP_PROTHEUS_FAIXA inteira positiva, senão 700.000', () => {
  assert.equal(E.faixaDe({}), 700000);
  assert.equal(E.faixaDe({ CIOSP_PROTHEUS_FAIXA: '790000' }), 790000);
  assert.equal(E.faixaDe({ CIOSP_PROTHEUS_FAIXA: 'abc' }), 700000);
  assert.equal(E.faixaDe({ CIOSP_PROTHEUS_FAIXA: '-5' }), 700000);
});

test('RG digitado no painel vale sobre o do pedido; PJ nunca manda RG', () => {
  assert.equal(E.montarEnvio({ pedido: { ...P, cliente_rg_ie: '' }, itens: IT, escolhas: { ...ESC, rg: '98.765.432-1' } }).cliente.rg, '98.765.432-1');
  assert.equal(E.montarEnvio({ pedido: P, itens: IT, escolhas: { ...ESC, rg: '' } }).cliente.rg, '12.345.678-9');
  const pj = { ...P, cliente_doc: '12345678000199', cliente_rg_ie: '123.456.789.110' };
  assert.equal(E.montarEnvio({ pedido: pj, itens: IT, escolhas: { ...ESC, rg: '1' } }).cliente.rg, '');
});
