// Testes do painel "Lançar no Protheus" (services/ciospProtheusProposta.js): o que o
// painel propõe e o que falta para o botão liberar. Rodar:  npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../services/ciospProtheusProposta');

const AGORA = new Date('2027-01-28T12:00:00Z');
const PEDIDO = {
  id: 7, edicao: 'CIOSP 2027', numero: 12, situacao: 'conferido', adm_responsavel: 7,
  credito_status: 'aprovado', contrato_assinado_em: AGORA, protheus_pedido: null, protheus_envio: null,
  cliente_doc: '45282860848', cliente_nome: 'Vitória Bueno', cliente_cod: '015000', cliente_loja: '01',
  cliente_email: 'c@x.com', cliente_fone: '', cliente_celular: '13997306455', cliente_cep: '11700000',
  cliente_endereco: 'Rua A, 1', cliente_bairro: 'Centro', cliente_cidade: 'Praia Grande', cliente_uf: 'SP',
  parcelas: 10, frete_valor: '0', acrescimo_norte: '0', entrega_parcial: false, cliente_genero: null, cliente_nascimento: null
};
const LISTAS = {
  bus: [{ codigo: 'COV' }, { codigo: 'REP' }], vendedores: [{ codigo: '000091' }],
  condicoes: [{ codigo: '001' }, { codigo: '409' }], tes: [{ codigo: '530' }, { codigo: '531' }],
  transportadoras: [{ codigo: '000001' }, { codigo: '000012' }]
};
function base(o = {}) {
  return {
    pedido: { ...PEDIDO, ...(o.pedido || {}) },
    itens: o.itens || [{ seq: 1, produto: '005796', descricao: 'G2', quantidade: '1', preco: '2427.86' }],
    membro: o.membro !== undefined ? o.membro : { protheus_vendedor: '000091', protheus_bu: 'COV' },
    forma: o.forma !== undefined ? o.forma : { protheus_condicao: '400', protheus_condicao_parcelada: true, protheus_forma: '3' },
    cliente: o.cliente || { lojas: [{ codigo: '015000', loja: '01', nome: 'VITORIA', bloqueado: false, condicao: null }] },
    municipios: o.municipios || [{ cod_mun: '41000', nome: 'PRAIA GRANDE' }],
    produtos: o.produtos || { '005796': { descricao: 'G2', bloqueado: false, tipo: 'PA', anvisa_barrado: false, ipi: 5.2 } },
    listas: o.listas || LISTAS,
    ultima: o.ultima || null,
    ativo: true
  };
}
const pronto = (p, extra = {}) => ({ ...p.escolhas, transportadora: '000001', tes: { 1: '530' }, ...extra });

test('proposta pronta: nada falta depois de escolher TES e transportadora', () => {
  const p = P.montarProposta(base());
  assert.equal(p.cliente.situacao, 'encontrado');
  assert.equal(p.escolhas.cliente_codigo, '015000');
  assert.equal(p.escolhas.condicao, '409');
  assert.equal(p.escolhas.bu, 'COV'); assert.equal(p.escolhas.vendedor, '000091'); assert.equal(p.escolhas.forma_pagto, '3');
  assert.equal(p.escolhas.tipo_frete, 'C'); assert.equal(p.escolhas.fat_parcial, 'N');
  assert.deepEqual(p.faltas_fixas, []);
  assert.deepEqual(P.faltasParaEnviar(p, pronto(p)), []);
  assert.deepEqual(p.totais, { itens: 2427.86, frete: 0, acrescimo: 0, total: 2427.86 });
});

test('sem TES, transportadora, BU e vendedor o botão diz o que falta', () => {
  const p = P.montarProposta(base({ membro: null }));
  const f = P.faltasParaEnviar(p, p.escolhas);
  for (const t of ['BU', 'vendedor', 'transportadora', 'TES em todos os itens']) assert.ok(f.includes(t), t);
});

test('condição só é proposta se existir no SE4', () => {
  const p = P.montarProposta(base({ listas: { ...LISTAS, condicoes: [{ codigo: '001' }] } }));
  assert.equal(p.escolhas.condicao, '');
});

test('nº digitado à mão bloqueia o botão', () => {
  const p = P.montarProposta(base({ pedido: { protheus_pedido: '012345', protheus_envio: null } }));
  assert.ok(p.faltas_fixas.includes('o pedido já tem nº do Protheus informado à mão'));
});

test('pedido não conferido, sem crédito ou sem contrato não vai', () => {
  const p = P.montarProposta(base({ pedido: { situacao: 'em_analise', credito_status: 'pendente', contrato_assinado_em: null } }));
  assert.deepEqual(p.faltas_fixas.slice(0, 3), ['pedido conferido', 'crédito aprovado', 'contrato assinado']);
});

test('item livre e quantidade fracionada não vão', () => {
  const p = P.montarProposta(base({ itens: [{ seq: 1, produto: '', descricao: 'Brinde', quantidade: '1', preco: '0' },
    { seq: 2, produto: '005796', descricao: 'G2', quantidade: '1.5', preco: '10' }] }));
  assert.ok(p.faltas_fixas.includes('item sem código do Protheus: Brinde'));
  assert.ok(p.faltas_fixas.includes('quantidade inteira em G2'));
});

test('produto inexistente, bloqueado ou barrado pela ANVISA vira falta e aviso no item', () => {
  const p = P.montarProposta(base({
    produtos: { '005797': { tipo: 'PA', bloqueado: true }, '005798': { tipo: 'PA', anvisa_barrado: true } },
    itens: [{ seq: 1, produto: '005796', descricao: 'G2', quantidade: '1', preco: '1' },
      { seq: 2, produto: '005797', descricao: 'Kit', quantidade: '1', preco: '1' },
      { seq: 3, produto: '005798', descricao: 'Refletor', quantidade: '1', preco: '1' }]
  }));
  assert.ok(p.faltas_fixas.includes('produto 005796 não existe no Protheus'));
  assert.ok(p.faltas_fixas.includes('produto 005797 bloqueado no Protheus'));
  assert.ok(p.faltas_fixas.includes('produto 005798 barrado pela ANVISA'));
  assert.equal(p.itens[1].aviso, 'produto 005797 bloqueado no Protheus');
});

test('cliente bloqueado e Protheus indisponível são faltas fixas', () => {
  const b = P.montarProposta(base({ cliente: { lojas: [{ codigo: '015000', loja: '01', nome: 'C', bloqueado: true, condicao: null }] } }));
  assert.ok(b.faltas_fixas.includes('cliente bloqueado no Protheus'));
  const i = P.montarProposta(base({ cliente: { erro: 'Protheus inacessível' }, produtos: { erro: 'Protheus inacessível' } }));
  assert.equal(i.cliente.situacao, 'indisponivel');
  assert.ok(i.faltas_fixas.includes('Protheus indisponível para consultar o cliente'));
  assert.ok(i.faltas_fixas.includes('Protheus indisponível para consultar os produtos'));
});

test('várias lojas: pede a loja, e a loja escolhida precisa ser do cliente', () => {
  const lojas = [{ codigo: '015000', loja: '01', nome: 'C', bloqueado: false, condicao: null },
    { codigo: '015000', loja: '02', nome: 'C', bloqueado: false, condicao: null }];
  const p = P.montarProposta(base({ pedido: { cliente_cod: null, cliente_loja: null }, cliente: { lojas } }));
  assert.equal(p.cliente.situacao, 'varias_lojas');
  assert.ok(P.faltasParaEnviar(p, pronto(p)).includes('escolher a loja do cliente'));
  assert.deepEqual(P.faltasParaEnviar(p, pronto(p, { cliente_codigo: '015000', cliente_loja: '02' })), []);
  assert.ok(P.faltasParaEnviar(p, pronto(p, { cliente_codigo: '015000', cliente_loja: '09' })).includes('escolher a loja do cliente'));
  const q = P.montarProposta(base({ cliente: { lojas } }));
  assert.equal(q.cliente.situacao, 'encontrado'); assert.equal(q.escolhas.cliente_loja, '01');
});

test('cliente novo PJ pede data de abertura e município, não gênero', () => {
  const p = P.montarProposta(base({ pedido: { cliente_doc: '12345678000199' }, cliente: { lojas: [] }, municipios: [] }));
  assert.equal(p.cliente.situacao, 'novo'); assert.equal(p.cliente.pessoa, 'J');
  const f = P.faltasParaEnviar(p, pronto(p));
  assert.ok(f.includes('data de abertura')); assert.ok(f.includes('município do cliente'));
  assert.ok(!f.includes('gênero do cliente'));
});

test('cliente novo PF pede gênero e data de nascimento; preenchidos, passa', () => {
  const p = P.montarProposta(base({ cliente: { lojas: [] } }));
  assert.equal(p.escolhas.cod_mun, '41000');
  const f = P.faltasParaEnviar(p, pronto(p));
  assert.ok(f.includes('gênero do cliente')); assert.ok(f.includes('data de nascimento'));
  assert.deepEqual(P.faltasParaEnviar(p, pronto(p, { genero: 'F', nascimento: '1990-05-17' })), []);
});

test('cliente novo sem telefone nem celular cai em falta', () => {
  const p = P.montarProposta(base({ pedido: { cliente_fone: '', cliente_celular: '' }, cliente: { lojas: [] } }));
  assert.ok(P.faltasParaEnviar(p, p.escolhas).includes('telefone ou celular do cliente'));
});

test('município com acento e caixa diferente é encontrado; ambíguo não', () => {
  const lista = [{ cod_mun: '50308', nome: 'SAO PAULO' }, { cod_mun: '1', nome: 'X' }, { cod_mun: '2', nome: 'X' }];
  assert.deepEqual(P.acharMunicipio(lista, 'São Paulo'), { cod_mun: '50308', nome: 'SAO PAULO' });
  assert.deepEqual(P.acharMunicipio(lista, '  sao   paulo '), { cod_mun: '50308', nome: 'SAO PAULO' });
  assert.equal(P.acharMunicipio(lista, 'x'), null);
  assert.equal(P.acharMunicipio({ erro: 'x' }, 'São Paulo'), null);
});

test('condição fixa do cliente diferente da escolhida bloqueia', () => {
  const p = P.montarProposta(base({ cliente: { lojas: [{ codigo: '015000', loja: '01', nome: 'C', bloqueado: false, condicao: '001' }] } }));
  assert.equal(p.cliente.condicao_fixa, '001');
  const f = P.faltasParaEnviar(p, pronto(p, { condicao: '409' }));
  assert.ok(f.includes('condição diferente da fixa do cliente (A1_COND = 001)'));
  assert.deepEqual(P.faltasParaEnviar(p, pronto(p, { condicao: '001' })), []);
});

test('códigos fora das listas do Protheus são recusados', () => {
  const p = P.montarProposta(base());
  const f = P.faltasParaEnviar(p, pronto(p, { bu: 'XYZ', vendedor: '999999', condicao: '777', transportadora: '000099', tes: { 1: '624' } }));
  assert.ok(f.includes('BU XYZ não existe no Protheus'));
  assert.ok(f.includes('vendedor 999999 não existe ou está bloqueado'));
  assert.ok(f.includes('condição 777 não existe'));
  assert.ok(f.includes('TES 624 não existe ou está bloqueada'));
  assert.ok(f.includes('transportadora 000099 não existe'));
});

test('pedido misto com acréscimo da Amazônia bloqueia e força faturamento parcial', () => {
  const p = P.montarProposta(base({ pedido: { acrescimo_norte: '72.84' }, produtos: { '005796': { tipo: 'PA' }, '009001': { tipo: 'SV' } },
    itens: [{ seq: 1, produto: '005796', descricao: 'G2', quantidade: '1', preco: '10' }, { seq: 2, produto: '009001', descricao: 'Garantia', quantidade: '1', preco: '5' }] }));
  assert.equal(p.misto, true); assert.equal(p.escolhas.fat_parcial, 'S');
  assert.equal(p.itens[1].servico, true);
  assert.ok(P.faltasParaEnviar(p, p.escolhas).includes('pedido com produto e serviço não aceita frete nem acréscimo da Amazônia'));
  assert.ok(P.faltasParaEnviar(p, { ...p.escolhas, fat_parcial: 'N' }).includes('faturamento parcial S (pedido com produto e serviço)'));
});

test('a última tentativa pré-preenche as escolhas; TES ordenadas com as do CIOSP primeiro', () => {
  const p = P.montarProposta(base({ ultima: { escolhas: { transportadora: '000012', tes: { 1: '531' } } } }));
  assert.equal(p.escolhas.transportadora, '000012'); assert.equal(p.escolhas.tes[1], '531');
  assert.equal(p.escolhas.bu, 'COV');
  assert.deepEqual(P.ordenarTes([{ codigo: '700' }, { codigo: '531' }, { codigo: '530' }, { codigo: '600' }]).map(t => t.codigo), ['530', '531', '600', '700']);
});

test('gênero e data do pedido entram nas escolhas; data do node-pg não volta um dia', () => {
  const p = P.montarProposta(base({ pedido: { cliente_genero: 'M', cliente_nascimento: new Date(1985, 0, 31) }, cliente: { lojas: [] } }));
  assert.equal(p.escolhas.genero, 'M'); assert.equal(p.escolhas.nascimento, '1985-01-31');
});
