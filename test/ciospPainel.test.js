// Testes do pedido → linha do painel do CIOSP (services/ciospPainel.js).
// Rodar:  npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../services/ciospPainel');

test('dataBrasil usa o dia de Brasília (a VPS roda em UTC)', () => {
  assert.equal(P.dataBrasil(new Date('2027-01-28T01:30:00Z')), '2027-01-27');
  assert.equal(P.dataBrasil(new Date('2027-01-28T15:00:00Z')), '2027-01-28');
});

test('resumoItens junta descrição curta e quantidade', () => {
  assert.equal(P.resumoItens([{ descricao: 'CADEIRA G2 COMPLETA', quantidade: 1 }, { descricao: 'REFLETOR LED 9442', quantidade: '2.000' }]),
    'CADEIRA G2 COMPLETA × 1 + REFLETOR LED 9442 × 2');
});

test('resumoItens corta descrição longa no último espaço antes de 40', () => {
  const curta = P.resumoItens([{ descricao: 'CONSULTÓRIO GNATUS G2   COMPOSTO DE CADEIRA, EQUIPO E UNIDADE DE ÁGUA', quantidade: 1 }]).split(' × ')[0];
  assert.ok(curta.length <= 40);
  assert.ok(!curta.endsWith(' '));
  assert.ok(curta.startsWith('CONSULTÓRIO GNATUS G2 COMPOSTO'));
});

test('resumoItens cabe em 300 caracteres', () => {
  const muitos = P.resumoItens(Array.from({ length: 30 }, () => ({ descricao: 'PEÇA DE MÃO ALTA ROTAÇÃO', quantidade: 1 })));
  assert.ok(muitos.length <= 300);
  assert.ok(muitos.endsWith('…'));
});

const pedido = (o = {}) => ({
  id: 3, edicao: 'CIOSP 2027', numero: 12, situacao: 'conferido', cliente_nome: 'Clínica X',
  cliente_doc: '12345678000199', cliente_uf: 'SP', entrega_uf: null,
  enviado_em: new Date('2027-01-28T01:30:00Z'), parcelas: 10, tabela_comissao: 13, total: '15000.50',
  origem: null, protheus_pedido: null, vendedor_nome: 'Ana Souza',
  painel_categoria: null, painel_gerente: null, painel_equipe: null, ...o
});
const ctx = (o = {}) => ({
  membro: { nome_exibicao: 'Ana', categoria: 'EQUIPAMENTOS', equipe: 'Equipe SP' },
  gerenteNome: 'Carlos', forma: { nome: 'Unicred', financeira: true },
  itens: [{ descricao: 'CADEIRA G2', quantidade: 1 }], ...o
});

test('linhaPainel monta a linha do pedido conferido', () => {
  const { linha, erro } = P.linhaPainel(pedido(), ctx());
  assert.equal(erro, undefined);
  assert.deepEqual(linha, {
    edicao: 'CIOSP 2027', categoria: 'EQUIPAMENTOS', cliente: 'Clínica X', cpf_cnpj: '12345678000199',
    data_venda: '2027-01-27', vendedor: 'Ana', uf: 'SP', pagto_princ: 'Unicred', pagto_compl: '10x',
    financiadora: 'Unicred', situacao_fin: 'Pendente', gerente: 'Carlos', origem: 'Presencial',
    equipe: 'Equipe SP', valor: 15000.5, tabela: '13%', equipamentos: 'CADEIRA G2 × 1',
    observacao: 'Pedido CIOSP nº 12', pedido_id: 3
  });
});

test('linhaPainel: finalizado vira Ok e leva o nº do Protheus', () => {
  const { linha } = P.linhaPainel(pedido({ situacao: 'finalizado', protheus_pedido: '012345' }), ctx());
  assert.equal(linha.situacao_fin, 'Ok');
  assert.equal(linha.observacao, 'Pedido CIOSP nº 12 · Protheus 012345');
});

test('linhaPainel: ajustes do ADM vencem a equipe do evento', () => {
  const { linha } = P.linhaPainel(pedido({ painel_categoria: 'DIGITAL', painel_gerente: 'Bia', painel_equipe: 'Revenda X' }), ctx());
  assert.equal(linha.categoria, 'DIGITAL');
  assert.equal(linha.gerente, 'Bia');
  assert.equal(linha.equipe, 'Revenda X');
});

test('linhaPainel: vendedor fora da equipe precisa de categoria do ADM', () => {
  const r = P.linhaPainel(pedido(), ctx({ membro: null, gerenteNome: null }));
  assert.match(r.erro, /categoria do painel/);
  const { linha } = P.linhaPainel(pedido({ painel_categoria: 'DIGITAL' }), ctx({ membro: null, gerenteNome: null }));
  assert.equal(linha.vendedor, 'Ana Souza');
  assert.equal(linha.gerente, null);
  assert.equal(linha.equipe, null);
});

test('linhaPainel: forma sem financeira, sem parcelas, entrega na região amazônica, 11%', () => {
  const { linha } = P.linhaPainel(pedido({ parcelas: null, entrega_uf: 'AM', tabela_comissao: 11, origem: 'Online' }),
    ctx({ forma: { nome: 'Pix — 10%', financeira: false } }));
  assert.equal(linha.financiadora, null);
  assert.equal(linha.pagto_princ, 'Pix — 10%');
  assert.equal(linha.pagto_compl, null);
  assert.equal(linha.uf, 'AM');
  assert.equal(linha.tabela, '11%');
  assert.equal(linha.origem, 'Online');
});
