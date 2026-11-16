// Testes das leituras do Protheus para o painel "Lançar no Protheus"
// (services/ciospProtheus.js), com um SQL Server falso. Rodar:  npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const CP = require('../services/ciospProtheus');

// app falso: devolve linhas pela tabela citada no SQL e conta as consultas.
function appFalso(linhasPorTabela, { falha = false } = {}) {
  const consultas = [];
  return {
    consultas,
    services: {
      Protheus: {
        connectAndQuery: async (sql, params) => {
          consultas.push({ sql, params });
          if (falha) throw new Error('Failed to connect');
          const tabela = Object.keys(linhasPorTabela).find(t => sql.includes(t));
          return tabela ? linhasPorTabela[tabela] : [];
        }
      }
    }
  };
}

test('lerCliente traduz bloqueio e condição fixa e ordena por loja', async () => {
  const app = appFalso({ SA1010: [
    { codigo: '015000 ', loja: '02', nome: 'CLINICA X ', msblql: '1', cond: '   ' },
    { codigo: '015000', loja: '01', nome: 'CLINICA X', msblql: '2', cond: '001' }
  ] });
  const r = await CP.lerCliente(app, '45.282.860/8480-00');
  assert.deepEqual(r.lojas, [
    { codigo: '015000', loja: '01', nome: 'CLINICA X', bloqueado: false, condicao: '001' },
    { codigo: '015000', loja: '02', nome: 'CLINICA X', bloqueado: true, condicao: null }
  ]);
  assert.equal(app.consultas[0].params.doc, '45282860848000');
});

test('lerProdutos marca ANVISA 2 como barrado e lê IPI e tipo', async () => {
  const app = appFalso({ SB1010: [
    { cod: '005796', descr: 'G2 ', msblql: '2', tipo: 'PA', anvisa: '', ipi: '5.2' },
    { cod: '009001', descr: 'GARANTIA', msblql: '1', tipo: 'SV', anvisa: '2', ipi: 0 }
  ] });
  const r = await CP.lerProdutos(app, ['005796', '009001', '005796', '']);
  assert.deepEqual(r['005796'], { descricao: 'G2', bloqueado: false, tipo: 'PA', anvisa_barrado: false, ipi: 5.2 });
  assert.equal(r['009001'].bloqueado, true);
  assert.equal(r['009001'].anvisa_barrado, true);
  assert.equal(r['009001'].tipo, 'SV');
  assert.equal(app.consultas.length, 1);
});

test('campo da ANVISA só entra no SQL quando configurado (B1_XANVISA ainda não existe)', async () => {
  const antes = process.env.CIOSP_SB1_CAMPO_ANVISA;
  try {
    delete process.env.CIOSP_SB1_CAMPO_ANVISA;
    const a = appFalso({ SB1010: [] });
    await CP.lerProdutos(a, ['005796']);
    assert.ok(!a.consultas[0].sql.includes('XANVISA'));
    process.env.CIOSP_SB1_CAMPO_ANVISA = 'B1_XANVISA';
    const b = appFalso({ SB1010: [] });
    await CP.lerProdutos(b, ['005796']);
    assert.ok(b.consultas[0].sql.includes('B1_XANVISA'));
    process.env.CIOSP_SB1_CAMPO_ANVISA = 'B1_X; DROP';
    const c = appFalso({ SB1010: [] });
    await CP.lerProdutos(c, ['005796']);
    assert.ok(!c.consultas[0].sql.includes('DROP'));
  } finally {
    if (antes === undefined) delete process.env.CIOSP_SB1_CAMPO_ANVISA; else process.env.CIOSP_SB1_CAMPO_ANVISA = antes;
  }
});

test('lerProdutos sem códigos não consulta', async () => {
  const app = appFalso({});
  assert.deepEqual(await CP.lerProdutos(app, []), {});
  assert.equal(app.consultas.length, 0);
});

test('lerMunicipios lê o CC2 da UF', async () => {
  const app = appFalso({ CC2010: [{ cod_mun: '41000', nome: 'PRAIA GRANDE ' }] });
  assert.deepEqual(await CP.lerMunicipios(app, 'sp'), [{ cod_mun: '41000', nome: 'PRAIA GRANDE' }]);
  assert.equal(app.consultas[0].params.uf, 'SP');
});

test('lerListas usa cache: segunda chamada não consulta; TES do CIOSP primeiro', async () => {
  CP.limparCache();
  const app = appFalso({
    SX5010: [{ codigo: 'COV', descricao: 'Comercial Varejo' }],
    SA3010: [{ codigo: '000091', descricao: 'JOANA' }],
    SE4010: [{ codigo: '409', descricao: 'SE + 10x' }],
    SF4010: [{ codigo: '700', descricao: 'OUTRA', cfop: '5102', ipi: 'N' }, { codigo: '531', descricao: 'VENDA', cfop: '5102', ipi: 'N' }, { codigo: '530', descricao: 'VENDA IPI', cfop: '5101', ipi: 'S' }],
    SA4010: [{ codigo: '000001', descricao: 'GNATUS' }]
  });
  const a = await CP.lerListas(app);
  assert.deepEqual(a.bus, [{ codigo: 'COV', descricao: 'Comercial Varejo' }]);
  assert.deepEqual(a.tes.map(t => t.codigo), ['530', '531', '700']);
  assert.equal(a.tes[0].cfop, '5101');
  const n = app.consultas.length;
  await CP.lerListas(app);
  assert.equal(app.consultas.length, n);
  CP.limparCache();
});

test('SQL que falha vira { erro } e não vai para o cache', async () => {
  CP.limparCache();
  const app = appFalso({}, { falha: true });
  assert.deepEqual(await CP.lerCliente(app, '45282860848'), { erro: 'Protheus inacessível' });
  assert.deepEqual(await CP.lerProdutos(app, ['1']), { erro: 'Protheus inacessível' });
  assert.deepEqual(await CP.lerMunicipios(app, 'SP'), { erro: 'Protheus inacessível' });
  assert.deepEqual(await CP.lerListas(app), { erro: 'Protheus inacessível' });
  const n = app.consultas.length;
  await CP.lerListas(app);
  assert.ok(app.consultas.length > n);
});
