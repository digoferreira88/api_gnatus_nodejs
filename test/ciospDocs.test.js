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
