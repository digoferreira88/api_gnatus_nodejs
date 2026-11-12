// Testes da regra de preço do CIOSP (services/ciospPreco.js).
// Rodar:  npm test
//
// Valores tirados da Tabela Comercial CIOSP 2026 (docs/ciosp/TabelaComercial_CIOSP2026_finalizado.pdf).

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../services/ciospPreco');

// 530 4462 FILME AUTORREVELÁVEL (CX C/ 50)
const filme = { preco_13_10x: 484.95, preco_13_6x: 460.70, preco_11_10x: 460.70, preco_11_6x: 442.27, promocao_pct: null };
// 530 8486 TIP G1 — "10% DE DESCONTO ADICIONAL"
const tipG1 = { preco_13_10x: 124.77, preco_13_6x: 118.53, preco_11_10x: 118.53, preco_11_6x: 113.79, promocao_pct: 10 };

const cartao10x = { coluna_base: '10x', desconto_pct: 0 };
const pix10 = { coluna_base: '10x', desconto_pct: 10 };
const pix6 = { coluna_base: '6x', desconto_pct: 6 };
const semLivre = { desconto_livre_pct: 0 };

test('paraCentavos aceita número e texto em formato brasileiro ou americano', () => {
  assert.equal(P.paraCentavos('R$ 1.234,56'), 123456);
  assert.equal(P.paraCentavos('1.234,56'), 123456);
  assert.equal(P.paraCentavos(1234.56), 123456);
  assert.equal(P.paraCentavos('1234.56'), 123456);
  assert.equal(P.paraCentavos('R$ 1,234.56'), 123456);
  assert.equal(P.paraCentavos('484,95'), 48495);
  assert.ok(Number.isNaN(P.paraCentavos('abc')));
  assert.ok(Number.isNaN(P.paraCentavos('')));
  assert.ok(Number.isNaN(P.paraCentavos(null)));
});

test('precoBase usa a coluna da tabela e da forma de pagamento', () => {
  assert.equal(P.precoBase(filme, '13', cartao10x), 484.95);
  assert.equal(P.precoBase(filme, '13', { coluna_base: '6x', desconto_pct: 0 }), 460.70);
  assert.equal(P.precoBase(filme, '11', cartao10x), 460.70);
});

test('precoBase aplica o desconto da forma arredondando meio centavo para cima', () => {
  // 484,95 × 0,90 = 436,455 → 436,46
  assert.equal(P.precoBase(filme, '13', pix10), 436.46);
  // 442,27 × 0,94 = 415,7338 → 415,73
  assert.equal(P.precoBase(filme, '11', pix6), 415.73);
});

test('precoBase recusa tabela ou coluna desconhecida', () => {
  assert.throws(() => P.precoBase(filme, '15', cartao10x), /tabela/i);
  assert.throws(() => P.precoBase(filme, '13', { coluna_base: '12x', desconto_pct: 0 }), /coluna/i);
});

test('descontoLivrePct soma a promoção da linha e o desconto livre da edição', () => {
  assert.equal(P.descontoLivrePct({ promocao_pct: 10 }, { desconto_livre_pct: 0 }), 10);
  assert.equal(P.descontoLivrePct({ promocao_pct: null }, { desconto_livre_pct: 5 }), 5);
  assert.equal(P.descontoLivrePct({ promocao_pct: 10 }, { desconto_livre_pct: 2.5 }), 12.5);
});

test('precoMinimo é o preço base menos o desconto livre', () => {
  // 124,77 × 0,90 = 112,293 → 112,29
  assert.equal(P.precoMinimo(tipG1, '13', cartao10x, semLivre), 112.29);
  assert.equal(P.precoMinimo(filme, '13', cartao10x, semLivre), 484.95);
});

test('exigeAprovacao só quando algum item fica abaixo do mínimo', () => {
  assert.equal(P.exigeAprovacao([{ linha: tipG1, preco: 112.29 }], '13', cartao10x, semLivre), false);
  assert.equal(P.exigeAprovacao([{ linha: tipG1, preco: 112.28 }], '13', cartao10x, semLivre), true);
  assert.equal(P.exigeAprovacao(
    [{ linha: filme, preco: 484.95 }, { linha: tipG1, preco: 100 }], '13', cartao10x, semLivre), true);
  assert.equal(P.exigeAprovacao([], '13', cartao10x, semLivre), false);
});

test('hashAprovacao não depende da ordem dos itens e muda com 1 centavo', () => {
  const a = { itens: [{ preco_id: 2, quantidade: 1, preco: 10 }, { preco_id: 1, quantidade: 2, preco: 5 }], tabela: '13', forma_id: 3 };
  const b = { itens: [{ preco_id: 1, quantidade: 2, preco: 5 }, { preco_id: 2, quantidade: 1, preco: 10 }], tabela: '13', forma_id: 3 };
  const c = { itens: [{ preco_id: 1, quantidade: 2, preco: 5 }, { preco_id: 2, quantidade: 1, preco: 10.01 }], tabela: '13', forma_id: 3 };
  assert.equal(P.hashAprovacao(a), P.hashAprovacao(b));
  assert.notEqual(P.hashAprovacao(a), P.hashAprovacao(c));
  assert.notEqual(P.hashAprovacao(a), P.hashAprovacao({ ...a, tabela: '11' }));
  assert.match(P.hashAprovacao(a), /^[a-f0-9]{64}$/);
});

test('exigeAprovacao trata preço ausente ou inválido como fora da regra', () => {
  assert.equal(P.exigeAprovacao([{ linha: filme, preco: null }], '13', cartao10x, semLivre), true);
  assert.equal(P.exigeAprovacao([{ linha: filme, preco: 'abc' }], '13', cartao10x, semLivre), true);
});

test('desconto livre nunca passa de 100% (preço mínimo nunca negativo)', () => {
  const promo100 = { ...filme, promocao_pct: 100 };
  assert.equal(P.descontoLivrePct(promo100, { desconto_livre_pct: 99 }), 100);
  assert.equal(P.precoMinimo(promo100, '13', cartao10x, { desconto_livre_pct: 99 }), 0);
  assert.equal(P.exigeAprovacao([{ linha: promo100, preco: -1 }], '13', cartao10x, { desconto_livre_pct: 99 }), true);
});
