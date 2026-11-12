// Testes do orçamento recalculado no servidor (services/ciospOrcamento.js).
// Rodar:  npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const O = require('../services/ciospOrcamento');

// 13% 10x = 1000; Pix 10% sobre a coluna 10x → base 900; promoção 5% → mínimo 855.
const LINHA = { id: 10, preco_13_10x: 1000, preco_13_6x: 950, preco_11_10x: 900, preco_11_6x: 860,
  promocao_pct: 5, promocao_texto: 'na compra do kit', promocao_condicional: true };
const ctx = { linhas: new Map([[10, LINHA]]), tabela: 13, forma: { id: 1, coluna_base: '10x', desconto_pct: 10 }, config: { desconto_livre_pct: 0 } };
const item = (o = {}) => ({ seq: 1, preco_id: 10, descricao: 'Cadeira', quantidade: 1, preco_tabela: 900, preco: 855, ...o });

test('recalcularItens: no mínimo não exige; um centavo abaixo exige', () => {
  const ok = O.recalcularItens([item()], ctx);
  assert.equal(ok.exige, false);
  assert.equal(ok.itens[0].preco_tabela, 900);
  assert.equal(ok.itens[0].preco, 855);
  assert.deepEqual(ok.diferencas, []);
  assert.equal(O.recalcularItens([item({ preco: 854.99 })], ctx).exige, true);
});

test('recalcularItens copia a promoção da linha da tabela', () => {
  const it = O.recalcularItens([item({ promocao_pct: null, promocao_texto: 'outra' })], ctx).itens[0];
  assert.equal(it.promocao_pct, 5);
  assert.equal(it.promocao_texto, 'na compra do kit');
  assert.equal(it.promocao_condicional, true);
});

test('recalcularItens: tabela mudou e o vendedor não deu desconto → praticado acompanha', () => {
  const r = O.recalcularItens([item({ preco_tabela: 1000, preco: 1000 })], ctx);
  assert.equal(r.itens[0].preco_tabela, 900);
  assert.equal(r.itens[0].preco, 900);
  assert.deepEqual(r.diferencas, [{ seq: 1, descricao: 'Cadeira', de: 1000, para: 900 }]);
});

test('recalcularItens: tabela mudou e havia desconto → mantém o combinado e avisa', () => {
  const r = O.recalcularItens([item({ preco_tabela: 1000, preco: 880 })], ctx);
  assert.equal(r.itens[0].preco_tabela, 900);
  assert.equal(r.itens[0].preco, 880);
  assert.equal(r.diferencas.length, 1);
  assert.equal(r.exige, false);
});

test('recalcularItens: item fora da tabela exige o gerente', () => {
  const semId = O.recalcularItens([item({ preco_id: null, preco_tabela: 50, preco: 50 })], ctx);
  assert.equal(semId.exige, true);
  assert.equal(semId.itens[0].preco, 50);
  const outraEdicao = O.recalcularItens([item({ preco_id: 999 })], ctx);
  assert.equal(outraEdicao.exige, true);
  assert.equal(outraEdicao.itens[0].preco_id, null);
});

test('recalcularItens: item novo sem preço vem com o preço base', () => {
  const r = O.recalcularItens([item({ preco_tabela: undefined, preco: undefined })], ctx);
  assert.equal(r.itens[0].preco_tabela, 900);
  assert.equal(r.itens[0].preco, 900);
  assert.deepEqual(r.diferencas, []);
});

// ---------------------------------------------------------------- situação do desconto

const T0 = new Date('2027-01-27T15:00:00Z');

test('estadoDesconto: dentro do livre limpa tudo', () => {
  assert.deepEqual(O.estadoDesconto({ exige: false, hash: 'h1', atual: { desconto_status: 'aprovado', desconto_hash: 'h1', desconto_solicitado_em: T0 } }),
    { desconto_status: 'livre', desconto_hash: null, desconto_solicitado_em: null });
});

test('estadoDesconto: mesma versão mantém aprovado, recusado e pendente solicitado', () => {
  for (const s of ['aprovado', 'recusado', 'pendente']) {
    assert.deepEqual(O.estadoDesconto({ exige: true, hash: 'h1', atual: { desconto_status: s, desconto_hash: 'h1', desconto_solicitado_em: T0 } }),
      { desconto_status: s, desconto_hash: 'h1', desconto_solicitado_em: T0 });
  }
});

test('estadoDesconto: preços novos derrubam a aprovação para pendente sem solicitação', () => {
  assert.deepEqual(O.estadoDesconto({ exige: true, hash: 'h2', atual: { desconto_status: 'aprovado', desconto_hash: 'h1', desconto_solicitado_em: T0 } }),
    { desconto_status: 'pendente', desconto_hash: null, desconto_solicitado_em: null });
  assert.deepEqual(O.estadoDesconto({ exige: true, hash: 'h2', atual: { desconto_status: 'livre', desconto_hash: null, desconto_solicitado_em: null } }),
    { desconto_status: 'pendente', desconto_hash: null, desconto_solicitado_em: null });
});

test('alemDoLivre: quanto o praticado está abaixo do mínimo', () => {
  assert.equal(O.alemDoLivre({ preco: 812.25 }, LINHA, 13, ctx.forma, ctx.config), 5);
  assert.equal(O.alemDoLivre({ preco: 855 }, LINHA, 13, ctx.forma, ctx.config), 0);
  assert.equal(O.alemDoLivre({ preco: 900 }, LINHA, 13, ctx.forma, ctx.config), 0);
});
