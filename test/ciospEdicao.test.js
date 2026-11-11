// Testes da gestão da edição do CIOSP (services/ciospEdicao.js).
// Rodar:  npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../services/ciospEdicao');

test('codigoUnico aceita só um código numérico', () => {
  assert.equal(E.codigoUnico('1116'), '1116');
  assert.equal(E.codigoUnico(' 16000003063 '), '16000003063');
  assert.equal(E.codigoUnico('5472 + 1134'), null);
  assert.equal(E.codigoUnico('2042 + 4060000520'), null);
  assert.equal(E.codigoUnico('CONF COR'), null);
  assert.equal(E.codigoUnico(''), null);
  assert.equal(E.codigoUnico(null), null);
});

test('candidatosB1 tenta o código como está e com 6 dígitos', () => {
  assert.deepEqual(E.candidatosB1('1116'), ['1116', '001116']);
  assert.deepEqual(E.candidatosB1('10957'), ['10957', '010957']);
  assert.deepEqual(E.candidatosB1('001116'), ['001116']);
  assert.deepEqual(E.candidatosB1('16000003063'), ['16000003063']);
});
