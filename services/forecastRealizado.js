// services/forecastRealizado.js — REALIZADO (vendido) por produto/mês vindo do
// Protheus, para uma carteira do forecast (vendedor_cods + UFs).
//
// Fonte: SD2 (itens faturados) × SF2 (cabeçalho: F2_VEND1=vendedor, F2_EMISSAO,
// F2_TIPO) × SA1 (cliente: A1_EST=UF). Só NOTAS de saída normais (F2_TIPO='N') —
// devolução de venda é doc de ENTRADA (SD1/SF1), então já fica de fora.
//
// Retorna um mapa { [produto_cod]: { 1..12: qtd } } com TODOS os produtos que o(s)
// vendedor(es) faturaram no ano — o caller cruza com a lista de produtos do forecast.
// READ-ONLY no Protheus.

const Protheus = require('./protheus');

const inList = (csv) => String(csv || '').split(',').map(s => s.trim()).filter(Boolean);

// Normaliza código de produto p/ casar o forecast (sem zeros à esquerda, ex. '994')
// com o Protheus (6 dígitos zero-padded, ex. '000994'). Códigos longos (EAN
// '16000004754') passam intactos. Usar dos DOIS lados ao cruzar.
const normCod = (c) => { const s = String(c || '').trim(); return s.replace(/^0+/, '') || s; };

// { ano, vendedorCods:'000018' | '0100,0101', ufs:'PR' | 'AC,AP,...' | '' }
async function realizado({ ano, vendedorCods, ufs }) {
  const vend = inList(vendedorCods);
  if (!vend.length) return {};                 // carteira sem vendedor (ex.: VANDERLEI) → vazio
  const uf = inList(ufs);

  const params = { ini: `${ano}0101`, fim: `${ano}1231` };
  vend.forEach((v, i) => { params['v' + i] = v; });
  const vendIn = vend.map((_, i) => `@v${i}`).join(',');

  // Só cruza SA1 (cliente) quando há filtro de UF — evita risco de inflar qtd por
  // eventual multiplicidade de SA1 e mantém o caminho "todas as UFs" enxuto.
  let ufJoin = '', ufFilter = '';
  if (uf.length) {
    uf.forEach((u, i) => { params['u' + i] = u; });
    ufJoin = `INNER JOIN SA1010 A1
             ON A1.A1_FILIAL = '01' AND A1.A1_COD = D2.D2_CLIENTE
            AND A1.A1_LOJA = D2.D2_LOJA AND A1.D_E_L_E_T_ = ''`;
    ufFilter = ` AND RTRIM(A1.A1_EST) IN (${uf.map((_, i) => `@u${i}`).join(',')})`;
  }

  const sql = `
    SELECT RTRIM(D2.D2_COD) AS produto,
           CAST(SUBSTRING(F2.F2_EMISSAO, 5, 2) AS INT) AS mes,
           SUM(D2.D2_QUANT) AS qtd
      FROM SD2010 D2
      INNER JOIN SF2010 F2
              ON F2.F2_FILIAL = D2.D2_FILIAL AND F2.F2_DOC = D2.D2_DOC
             AND F2.F2_SERIE = D2.D2_SERIE AND F2.F2_CLIENTE = D2.D2_CLIENTE
             AND F2.F2_LOJA = D2.D2_LOJA AND F2.D_E_L_E_T_ = ''
      ${ufJoin}
     WHERE D2.D_E_L_E_T_ = ''
       AND F2.F2_TIPO = 'N'
       AND F2.F2_EMISSAO BETWEEN @ini AND @fim
       AND RTRIM(F2.F2_VEND1) IN (${vendIn})
       ${ufFilter}
     GROUP BY RTRIM(D2.D2_COD), CAST(SUBSTRING(F2.F2_EMISSAO, 5, 2) AS INT)`;

  const rows = await Protheus.connectAndQuery(sql, params);
  const mapa = {};
  for (const r of rows) {
    const cod = normCod(r.produto);          // '000994' → '994' p/ casar o forecast
    const mes = Number(r.mes);
    if (!cod || !mes) continue;
    const m = (mapa[cod] || (mapa[cod] = {}));
    m[mes] = (m[mes] || 0) + (Number(r.qtd) || 0);   // soma se +1 código normaliza igual
  }
  return mapa;
}

module.exports = { realizado, inList, normCod };
