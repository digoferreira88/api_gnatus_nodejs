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

// ---------------------------------------------------------------- formas de pagamento

const formaOk = { nome: 'Unicred', coluna_base: '10x', desconto_pct: 0, parcelas_max: 12, exige_credito: false, financeira: true };

test('validarForma aceita uma forma completa', () => {
  const r = E.validarForma(formaOk);
  assert.equal(r.erro, undefined);
  assert.deepEqual(r.forma, { nome: 'Unicred', coluna_base: '10x', desconto_pct: 0, parcelas_max: 12, exige_credito: false, financeira: true, ativo: true, ordem: 0 });
});

test('validarForma exige nome de até 60 caracteres', () => {
  assert.match(E.validarForma({ ...formaOk, nome: ' ' }).erro, /nome/i);
  assert.match(E.validarForma({ ...formaOk, nome: 'x'.repeat(61) }).erro, /60/);
});

test('validarForma só aceita coluna 10x ou 6x', () => {
  assert.equal(E.validarForma({ ...formaOk, coluna_base: '6x' }).erro, undefined);
  assert.match(E.validarForma({ ...formaOk, coluna_base: '12x' }).erro, /coluna/i);
});

test('validarForma recusa desconto fora de 0 a 99,99', () => {
  assert.equal(E.validarForma({ ...formaOk, desconto_pct: '6' }).forma.desconto_pct, 6);
  assert.match(E.validarForma({ ...formaOk, desconto_pct: 100 }).erro, /desconto/i);
  assert.match(E.validarForma({ ...formaOk, desconto_pct: -1 }).erro, /desconto/i);
});

test('validarForma exige parcelas inteiras de 1 a 24', () => {
  assert.match(E.validarForma({ ...formaOk, parcelas_max: 0 }).erro, /parcelas/i);
  assert.match(E.validarForma({ ...formaOk, parcelas_max: 25 }).erro, /parcelas/i);
  assert.match(E.validarForma({ ...formaOk, parcelas_max: 2.5 }).erro, /parcelas/i);
});

// ---------------------------------------------------------------- equipe

const vendedor = { usuario_id: 10, nome_exibicao: 'Camila', papel: 'vendedor', gerente_id: 5, categoria: 'EQUIPAMENTOS', equipe: 'Comercial Varejo' };

test('validarMembro aceita vendedor com gerente', () => {
  const r = E.validarMembro(vendedor);
  assert.equal(r.erro, undefined);
  assert.equal(r.membro.usuario_id, 10);
  assert.equal(r.membro.categoria, 'EQUIPAMENTOS');
});

test('validarMembro exige usuário e nome', () => {
  assert.match(E.validarMembro({ ...vendedor, usuario_id: null }).erro, /usuário/i);
  assert.match(E.validarMembro({ ...vendedor, nome_exibicao: '' }).erro, /nome/i);
});

test('validarMembro só aceita papel vendedor ou gerente', () => {
  assert.match(E.validarMembro({ ...vendedor, papel: 'diretor' }).erro, /papel/i);
});

test('validarMembro só aceita categoria EQUIPAMENTOS, DIGITAL ou AT', () => {
  assert.equal(E.validarMembro({ ...vendedor, categoria: 'digital' }).membro.categoria, 'DIGITAL');
  assert.match(E.validarMembro({ ...vendedor, categoria: 'PEÇAS' }).erro, /categoria/i);
});

test('vendedor precisa de gerente; gerente não', () => {
  assert.match(E.validarMembro({ ...vendedor, gerente_id: null }).erro, /vendedor precisa de gerente/i);
  assert.equal(E.validarMembro({ ...vendedor, papel: 'gerente', gerente_id: null }).erro, undefined);
});

test('ninguém é gerente de si mesmo', () => {
  assert.match(E.validarMembro({ ...vendedor, gerente_id: 10 }).erro, /si mesmo/i);
});

test('FORMAS_PADRAO são as 4 condições impressas na Tabela Comercial', () => {
  assert.deepEqual(E.FORMAS_PADRAO.map(f => [f.nome, f.coluna_base, f.desconto_pct]), [
    ['Cartão até 10x', '10x', 0], ['Cartão até 6x', '6x', 0], ['Pix — 10%', '10x', 10], ['Pix — 6%', '6x', 6]
  ]);
});

test('q usa o pool da aplicação mesmo quando o app (Express) tem .query', async () => {
  const app = {
    query: () => { throw new Error('Route.query() chamado'); },   // o Express tem app.query
    services: { Pg: { pool: { query: async (sql, p) => ({ rows: [{ sql, p }] }) } } }
  };
  const rows = await E.q(app, 'SELECT $1', [7]);
  assert.deepEqual(rows, [{ sql: 'SELECT $1', p: [7] }]);
  const client = { query: async () => ({ rows: ['client'] }) };
  assert.deepEqual(await E.q(client, 'SELECT 1'), ['client']);
});

// Client falso: responde COUNT(*) com `formas` e registra os INSERTs.
function clienteFalso(formas) {
  const inserts = [];
  return {
    inserts,
    query: async (sql, p) => {
      if (/count\(\*\)/i.test(sql)) return { rows: [{ n: formas }] };
      if (/insert into tab_ciosp_forma_pagto/i.test(sql)) inserts.push(p[2]);
      return { rows: [] };
    }
  };
}

test('semearFormas cria as 4 formas quando a edição não tem nenhuma', async () => {
  const c = clienteFalso(0);
  await E.semearFormas(c, 'CIOSP 2027');
  assert.deepEqual(c.inserts, ['Cartão até 10x', 'Cartão até 6x', 'Pix — 10%', 'Pix — 6%']);
});

test('semearFormas não recria forma excluída ou renomeada (edição já tem formas)', async () => {
  const c = clienteFalso(3);
  await E.semearFormas(c, 'CIOSP 2027');
  assert.deepEqual(c.inserts, []);
});

test('herdarFotos mantém a foto da linha que continua na tabela nova', () => {
  const antigas = [
    { secao: 'CONSULTÓRIOS GNATUS G1', codigo: null, descricao: 'CONS GNATUS G1 FIT SF', foto_id: 7 },
    { secao: 'CADEIRA HOF', codigo: null, descricao: 'CADEIRA CLINICA HOF', foto_id: 8 }
  ];
  const novas = [
    { secao: 'CONSULTÓRIOS GNATUS G1', codigo: '', descricao: ' cons gnatus g1 fit sf ', ordem: 2 },
    { secao: 'CONSULTÓRIOS GNATUS G2', codigo: '', descricao: 'CONS GNATUS G2 H', ordem: 3 }
  ];
  const r = E.herdarFotos(novas, antigas);
  assert.equal(r.linhas[0].foto_id, 7);
  assert.equal(r.linhas[1].foto_id, null);
  assert.equal(r.mantidas, 1);
  assert.deepEqual(r.perdidas, ['CADEIRA HOF · CADEIRA CLINICA HOF']);
});
