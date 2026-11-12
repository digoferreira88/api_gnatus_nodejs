// Testes da planilha modelo da Tabela Comercial do CIOSP (services/ciospTabela.js).
// Rodar:  npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const T = require('../services/ciospTabela');

// Monta uma planilha em memória: `linhas` é uma lista de objetos {cabeçalho: valor}.
async function planilha(linhas, cabecalho = T.COLUNAS) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Tabela');
  ws.addRow(cabecalho);
  for (const l of linhas) ws.addRow(cabecalho.map(c => (c in l ? l[c] : null)));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const ok = {
  'Seção': 'PEÇAS DE MÃO', 'Grupo': 'ALTA ROTAÇÃO', 'TES': '530', 'Código': '1169',
  'Descrição': 'ALTA ROTAÇÃO AX1 LED',
  '13% 10x': 1417.63, '13% 6x': 1346.75, '11% 10x': 1346.75, '11% 6x': 1292.88,
  'Promoção (texto)': '10% DE DESCONTO ADICIONAL', 'Promoção (%)': 10,
  'Promoção condicional (S/N)': 'N', 'Prazo de fabricação (dias)': 15
};

test('COLUNAS tem os 13 cabeçalhos na ordem da spec', () => {
  assert.deepEqual(T.COLUNAS, [
    'Seção', 'Grupo', 'TES', 'Código', 'Descrição', '13% 10x', '13% 6x', '11% 10x', '11% 6x',
    'Promoção (texto)', 'Promoção (%)', 'Promoção condicional (S/N)', 'Prazo de fabricação (dias)'
  ]);
});

test('o modelo gerado é lido de volta sem erro', async () => {
  const r = await T.lerPlanilha(await T.gerarModelo());
  assert.equal(r.erros.length, 0, JSON.stringify(r.erros));
  assert.equal(r.linhas.length, 2);
});

test('linha válida vira LinhaPreco com os campos normalizados', async () => {
  const r = await T.lerPlanilha(await planilha([ok]));
  assert.deepEqual(r.erros, []);
  assert.deepEqual(r.linhas[0], {
    ordem: 2, secao: 'PEÇAS DE MÃO', grupo: 'ALTA ROTAÇÃO', tes: '530', codigo: '1169',
    descricao: 'ALTA ROTAÇÃO AX1 LED',
    preco_13_10x: 1417.63, preco_13_6x: 1346.75, preco_11_10x: 1346.75, preco_11_6x: 1292.88,
    promocao_texto: '10% DE DESCONTO ADICIONAL', promocao_pct: 10, promocao_condicional: false,
    prazo_fabric: 15
  });
});

test('preço em texto brasileiro e em célula numérica dão o mesmo valor', async () => {
  const r = await T.lerPlanilha(await planilha([
    { ...ok, '13% 10x': 'R$ 1.234,56' },
    { ...ok, '13% 10x': 1234.56 }
  ]));
  assert.equal(r.linhas[0].preco_13_10x, 1234.56);
  assert.equal(r.linhas[1].preco_13_10x, 1234.56);
});

test('descrição vazia é erro na linha certa', async () => {
  const r = await T.lerPlanilha(await planilha([ok, { ...ok, 'Descrição': '  ' }]));
  assert.equal(r.erros.length, 1);
  assert.equal(r.erros[0].linha, 3);
  assert.match(r.erros[0].msg, /Descrição/);
});

test('preço ausente ou inválido é erro citando a coluna', async () => {
  const r = await T.lerPlanilha(await planilha([{ ...ok, '11% 6x': null }, { ...ok, '13% 6x': 'abc' }]));
  assert.equal(r.erros.length, 2);
  assert.match(r.erros[0].msg, /11% 6x/);
  assert.match(r.erros[1].msg, /13% 6x/);
});

test('preço zero ou negativo é erro', async () => {
  const r = await T.lerPlanilha(await planilha([{ ...ok, '13% 10x': 0 }]));
  assert.equal(r.erros.length, 1);
  assert.match(r.erros[0].msg, /13% 10x/);
});

test('percentual de promoção fora de 0–100 é erro', async () => {
  const r = await T.lerPlanilha(await planilha([{ ...ok, 'Promoção (%)': 120 }]));
  assert.equal(r.erros.length, 1);
  assert.match(r.erros[0].msg, /Promoção \(%\)/);
});

test('6x mais caro que 10x, ou 11% mais caro que 13%, é aviso e não erro', async () => {
  const r = await T.lerPlanilha(await planilha([
    { ...ok, '13% 6x': 1500 },
    { ...ok, '11% 10x': 1500 }
  ]));
  assert.equal(r.erros.length, 0);
  assert.equal(r.avisos.length, 2);
  assert.equal(r.linhas.length, 2);
});

test('coluna obrigatória ausente no cabeçalho é erro geral na linha 1', async () => {
  const cab = T.COLUNAS.filter(c => c !== '11% 6x');
  const r = await T.lerPlanilha(await planilha([ok], cab));
  assert.ok(r.erros.some(e => e.linha === 1 && /11% 6x/.test(e.msg) && /ausente/.test(e.msg)));
  assert.equal(r.linhas.length, 0);
});

test('cabeçalho é localizado pelo texto, sem acento e em qualquer ordem', async () => {
  const cab = ['descricao', 'secao', '13% 10X', '13% 6X', '11% 10X', '11% 6X'];
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Tabela');
  ws.addRow(cab);
  ws.addRow(['ITEM X', 'SEÇÃO Y', 10, 9, 9, 8]);
  const r = await T.lerPlanilha(Buffer.from(await wb.xlsx.writeBuffer()));
  assert.deepEqual(r.erros, []);
  assert.equal(r.linhas[0].descricao, 'ITEM X');
  assert.equal(r.linhas[0].preco_11_6x, 8);
});

test('promoção condicional aceita S, sim e x', async () => {
  const r = await T.lerPlanilha(await planilha([
    { ...ok, 'Promoção condicional (S/N)': 'S' },
    { ...ok, 'Promoção condicional (S/N)': 'sim' },
    { ...ok, 'Promoção condicional (S/N)': 'x' },
    { ...ok, 'Promoção condicional (S/N)': null }
  ]));
  assert.deepEqual(r.linhas.map(l => l.promocao_condicional), [true, true, true, false]);
});

test('linhas idênticas em seções diferentes entram as duas; linha vazia é ignorada', async () => {
  const r = await T.lerPlanilha(await planilha([
    { ...ok, 'Seção': 'ITENS AVULSOS' },
    {},
    { ...ok, 'Seção': 'CADEIRA HOF' }
  ]));
  assert.deepEqual(r.erros, []);
  assert.equal(r.linhas.length, 2);
  assert.deepEqual(r.linhas.map(l => l.ordem), [2, 4]);
});

test('"10%" digitado no Excel (0,1 com formato de porcentagem) vira 10', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Tabela');
  ws.addRow(T.COLUNAS);
  ws.addRow(T.COLUNAS.map(c => (c in ok ? ok[c] : null)));
  const col = T.COLUNAS.indexOf('Promoção (%)') + 1;
  ws.getRow(2).getCell(col).value = 0.1;
  ws.getRow(2).getCell(col).numFmt = '0%';
  const r = await T.lerPlanilha(Buffer.from(await wb.xlsx.writeBuffer()));
  assert.deepEqual(r.erros, []);
  assert.equal(r.linhas[0].promocao_pct, 10);
});

test('percentual de promoção entre 0 e 1 sem formato de % gera aviso', async () => {
  const r = await T.lerPlanilha(await planilha([{ ...ok, 'Promoção (%)': 0.15 }]));
  assert.equal(r.erros.length, 0);
  assert.ok(r.avisos.some(a => /Promoção \(%\)/.test(a.msg)));
});
