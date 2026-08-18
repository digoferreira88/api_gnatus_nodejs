// services/forecastSeed.js — semeia a lista de produtos do forecast (do xlsx,
// extraída para data/forecast-produtos.json) e as carteiras (de-para aba→vendedor
// Protheus + UFs, confirmado com o Planejamento 18/08).
//
// Idempotente: produtos por UPSERT (codigo); carteiras só se a tabela estiver vazia
// (depois são geridas pela tela de gestão, perm 18002).

const fs = require('fs');
const path = require('path');

// De-para das "abas" do FORM 7.5.1.3. consolidar=false nas abas "detalhe" (CÁSSIO
// PR/SC/RS = recorte do CÁSSIO TOTAL) p/ não dobrar no total. VANDERLEI sem cadastro
// de vendedor → sem realizado (só previsão).
const CARTEIRAS = [
  { nome: 'CAMILA',                     vendedor_cods: '000003', ufs: '',                              consolidar: true,  ordem: 1 },
  { nome: 'CARLOS',                     vendedor_cods: '000066', ufs: '',                              consolidar: true,  ordem: 2 },
  { nome: 'ROBERTO (TOTAL)',            vendedor_cods: '0101',   ufs: '',                              consolidar: true,  ordem: 3 },
  { nome: 'ROSSANDRO (NORTE)',          vendedor_cods: '000018', ufs: 'AC,AP,AM,PA,RO,RR,TO',          consolidar: true,  ordem: 4 },
  { nome: 'ROSSANDRO (CENTRO OESTE)',   vendedor_cods: '000018', ufs: 'MT,MS,GO,DF',                   consolidar: true,  ordem: 5 },
  { nome: 'ROSSANDRO (NORDESTE)',       vendedor_cods: '000018', ufs: 'MA,PI,CE,RN,PB,PE,AL,SE,BA',    consolidar: true,  ordem: 6 },
  { nome: 'WLADIMIR',                   vendedor_cods: '000006', ufs: '',                              consolidar: true,  ordem: 7 },
  { nome: 'CÁSSIO TOTAL',               vendedor_cods: '0100',   ufs: '',                              consolidar: true,  ordem: 8 },
  { nome: 'CÁSSIO (PARANÁ)',            vendedor_cods: '0100',   ufs: 'PR',                             consolidar: false, ordem: 9 },
  { nome: 'CÁSSIO (SANTA CATARINA)',    vendedor_cods: '0100',   ufs: 'SC',                             consolidar: false, ordem: 10 },
  { nome: 'CÁSSIO (RIO GRANDE DO SUL)', vendedor_cods: '0100',   ufs: 'RS',                             consolidar: false, ordem: 11 },
  { nome: 'VANDERLEI',                  vendedor_cods: '',       ufs: '',                              consolidar: true,  ordem: 12 },
  { nome: 'RUBENS',                     vendedor_cods: '000175', ufs: '',                              consolidar: true,  ordem: 13 },
];

async function seedProdutos(Pg, jsonPath) {
  const p = jsonPath || path.join(__dirname, '..', 'data', 'forecast-produtos.json');
  const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
  const vistos = new Set();
  let n = 0;
  for (const item of arr) {
    const codigo = String(item.codigo || '').trim();
    if (!codigo || vistos.has(codigo)) continue;   // dedupe por código (xlsx tem repetidos)
    vistos.add(codigo);
    await Pg.connectAndQuery(
      `INSERT INTO tab_forecast_produto (codigo, descricao, ordem)
       VALUES (@c, @d, @o)
       ON CONFLICT (codigo) DO UPDATE SET descricao = EXCLUDED.descricao, ordem = EXCLUDED.ordem`,
      { c: codigo, d: String(item.descricao || '').trim(), o: Number(item.ordem) || null });
    n++;
  }
  return { produtos: n };
}

async function seedCarteiras(Pg) {
  const [{ c }] = await Pg.connectAndQuery(`SELECT COUNT(*)::int c FROM tab_forecast_carteira`);
  if (c > 0) return { carteiras: 0, jaExistia: c };
  for (const k of CARTEIRAS) {
    await Pg.connectAndQuery(
      `INSERT INTO tab_forecast_carteira (nome, vendedor_cods, ufs, consolidar, ordem)
       VALUES (@n, @v, @u, @c, @o)`,
      { n: k.nome, v: k.vendedor_cods, u: k.ufs, c: k.consolidar, o: k.ordem });
  }
  return { carteiras: CARTEIRAS.length };
}

module.exports = { seedProdutos, seedCarteiras, CARTEIRAS };
