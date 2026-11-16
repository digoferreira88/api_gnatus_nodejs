// Testes das regras compartilhadas de orçamento e pedido do CIOSP (services/ciospDocs.js).
// Rodar:  npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../services/ciospDocs');

test('montarItens guarda a linha da tabela e a promoção', () => {
  const r = D.montarItens([{ descricao: 'Refletor', quantidade: 1, preco: 100, preco_id: 55,
    promocao_pct: 10, promocao_texto: 'na compra do kit', promocao_condicional: true }]);
  assert.equal(r.itens[0].preco_id, 55);
  assert.equal(r.itens[0].promocao_pct, 10);
  assert.equal(r.itens[0].promocao_texto, 'na compra do kit');
  assert.equal(r.itens[0].promocao_condicional, true);
});

test('montarItens não corta a descrição dos consultórios em 200', () => {
  assert.equal(D.montarItens([{ descricao: 'x'.repeat(700), quantidade: 1, preco: 1 }]).itens[0].descricao.length, 700);
});

test('montarItens: sem promoção, campos nulos e condicional falso; preco_id inválido vira nulo', () => {
  const it = D.montarItens([{ descricao: 'a', quantidade: 1, preco: 1, preco_id: 'x' }]).itens[0];
  assert.equal(it.preco_id, null);
  assert.equal(it.promocao_pct, null);
  assert.equal(it.promocao_texto, null);
  assert.equal(it.promocao_condicional, false);
});

// ---------------------------------------------------------------- gênero e data (cadastro no Protheus)

test('normalizarGenero aceita F/M e nomes por extenso', () => {
  assert.equal(D.normalizarGenero('feminino'), 'F');
  assert.equal(D.normalizarGenero(' m '), 'M');
  assert.equal(D.normalizarGenero('Masculino'), 'M');
  assert.equal(D.normalizarGenero('E'), null);
  assert.equal(D.normalizarGenero(''), null);
  assert.equal(D.normalizarGenero(null), null);
});

test('normalizarData aceita ISO e DD/MM/AAAA e recusa data impossível ou futura', () => {
  const hoje = new Date('2027-01-28T12:00:00Z');
  assert.equal(D.normalizarData('17/05/1990', hoje), '1990-05-17');
  assert.equal(D.normalizarData('1990-05-17', hoje), '1990-05-17');
  assert.equal(D.normalizarData('31/02/1990', hoje), null);
  assert.equal(D.normalizarData('2027-02-01', hoje), null);
  assert.equal(D.normalizarData('1899-12-31', hoje), null);
  assert.equal(D.normalizarData('', hoje), null);
});

test('normalizarData aceita a data que volta do GET (ISO com hora)', () => {
  const hoje = new Date('2027-01-28T12:00:00Z');
  assert.equal(D.normalizarData('1990-05-17T03:00:00.000Z', hoje), '1990-05-17');
});

test('lerGeneroNascimento: vazio vira nulo, inválido vira erro', () => {
  assert.deepEqual(D.lerGeneroNascimento({}), { cliente_genero: null, cliente_nascimento: null });
  assert.deepEqual(D.lerGeneroNascimento({ cliente_genero: 'F', cliente_nascimento: '17/05/1990' }),
    { cliente_genero: 'F', cliente_nascimento: '1990-05-17' });
  assert.equal(D.lerGeneroNascimento({ cliente_genero: 'X' }).erro, 'Gênero: feminino ou masculino.');
  assert.equal(D.lerGeneroNascimento({ cliente_nascimento: '31/02/1990' }).erro, 'Data de nascimento ou de abertura inválida.');
});
