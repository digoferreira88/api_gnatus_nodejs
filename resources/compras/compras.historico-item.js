// GET /compras/historico-item?q=&limite=10&cfops=
// Histórico das últimas N compras de cada item (base no genérico SD1 — itens de
// NF de ENTRADA), p/ calcular preço de venda sobre o VALOR REAL de compra (não o
// custo médio da SB2). Filtra CFOPs de compra/aquisição. Campos: cód/nome
// fornecedor, emissão e digitação da NF, qtd, valor unitário, valor total e
// CUSTOMOEDA1 = D1_CUSTO (Custo de Entrada Moeda 1 — líquido, deduzindo impostos).
// Perm 4001/4002/4003.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([4001, 4002, 4003, 0]);
const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);

// CFOPs de compra/aquisição (default — editável via ?cfops=). Mercadoria p/
// industrialização/comercialização, uso/consumo, ativo, energia/combustível.
const CFOPS_COMPRA = [
  '1101', '1102', '1116', '1117', '1118', '1120', '1121', '1122', '1124', '1125', '1126', '1128', '1401', '1403', '1406', '1407', '1551', '1556', '1651', '1652', '1653',
  '2101', '2102', '2116', '2117', '2118', '2120', '2121', '2122', '2124', '2125', '2126', '2128', '2401', '2403', '2406', '2407', '2551', '2556', '2651', '2652', '2653',
  '3101', '3102', '3126', '3127', '3201', '3551', '3556', '3651', '3652', '3653'
];

module.exports = (app) => ({
  verb: 'get',
  route: '/historico-item',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const q = trim(req.query.q);
    if (q.length < 2) return res.status(400).json({ message: 'Informe ao menos 2 caracteres (código ou descrição do produto).' });
    let limite = parseInt(req.query.limite, 10); if (!Number.isFinite(limite) || limite < 1) limite = 10; if (limite > 50) limite = 50;

    // CFOPs: usa os do filtro (?cfops=) ou o default; sanitiza p/ dígitos
    const cfops = (trim(req.query.cfops) ? trim(req.query.cfops).split(/[,;\s]+/) : CFOPS_COMPRA)
      .map(c => c.replace(/\D/g, '')).filter(Boolean);
    const inCf = [...new Set(cfops)].map(c => `'${c}'`).join(',') || `'0'`;

    try {
      // 1) resolve até 50 produtos que casam com a busca (código prefixo ou descrição)
      const prods = await Protheus.connectAndQuery(`
        SELECT TOP 50 RTRIM(B1_COD) cod, RTRIM(B1_DESC) desc1, RTRIM(B1_UM) um
          FROM SB1010 WITH (NOLOCK)
         WHERE D_E_L_E_T_<>'*'
           AND (RTRIM(B1_COD) LIKE @q+'%' OR UPPER(B1_DESC) LIKE '%'+@qU+'%')
         ORDER BY B1_COD`, { q, qU: q.toUpperCase() });
      if (!prods.length) return res.json({ produtos: [], qtdProdutos: 0, cfops: [...new Set(cfops)], aviso: 'Nenhum produto encontrado.', geradoEm: new Date().toISOString() });

      const inProd = prods.map(p => `'${trim(p.cod).replace(/'/g, "''")}'`).join(',');

      // 2) últimas N compras por produto (ROW_NUMBER particionado)
      const rows = await Protheus.connectAndQuery(`
        SELECT * FROM (
          SELECT RTRIM(d1.D1_COD) cod,
                 RTRIM(d1.D1_FORNECE) forn, RTRIM(d1.D1_LOJA) loja, RTRIM(sa2.A2_NOME) fornNome,
                 d1.D1_EMISSAO emissao, d1.D1_DTDIGIT digitacao, RTRIM(d1.D1_DOC) doc, RTRIM(d1.D1_SERIE) serie, RTRIM(d1.D1_CF) cfop,
                 d1.D1_QUANT quant, d1.D1_VUNIT vunit, d1.D1_TOTAL total, d1.D1_CUSTO custoMoeda1,
                 ROW_NUMBER() OVER (PARTITION BY d1.D1_COD ORDER BY d1.D1_DTDIGIT DESC, d1.D1_EMISSAO DESC, d1.D1_DOC DESC) rn
            FROM SD1010 d1 WITH (NOLOCK)
            LEFT JOIN SA2010 sa2 WITH (NOLOCK) ON sa2.A2_COD=d1.D1_FORNECE AND sa2.A2_LOJA=d1.D1_LOJA AND sa2.D_E_L_E_T_<>'*'
           WHERE d1.D1_FILIAL='01' AND d1.D_E_L_E_T_<>'*'
             AND RTRIM(d1.D1_COD) IN (${inProd}) AND RTRIM(d1.D1_CF) IN (${inCf})
        ) t WHERE rn <= @limite ORDER BY cod, rn`, { limite });

      // agrupa por produto
      const mapDesc = new Map(prods.map(p => [trim(p.cod), { desc: trim(p.desc1), um: trim(p.um) }]));
      const byCod = new Map();
      rows.forEach(r => {
        const cod = trim(r.cod);
        if (!byCod.has(cod)) byCod.set(cod, []);
        byCod.get(cod).push({
          forn: trim(r.forn), loja: trim(r.loja), fornNome: trim(r.fornNome),
          emissao: trim(r.emissao), digitacao: trim(r.digitacao), doc: trim(r.doc), serie: trim(r.serie), cfop: trim(r.cfop),
          quant: N(r.quant), vunit: +N(r.vunit).toFixed(6), total: +N(r.total).toFixed(2), custoMoeda1: +N(r.custoMoeda1).toFixed(2)
        });
      });
      // só produtos que têm compras; ordena por código
      const produtos = prods
        .filter(p => byCod.has(trim(p.cod)))
        .map(p => ({ cod: trim(p.cod), desc: trim(p.desc1), um: trim(p.um), compras: byCod.get(trim(p.cod)) }));

      return res.json({
        produtos, qtdProdutos: produtos.length,
        cfops: [...new Set(cfops)], limite,
        aviso: prods.length === 50 ? 'Busca retornou muitos produtos — exibindo os 50 primeiros. Refine a busca.' : null,
        geradoEm: new Date().toISOString()
      });
    } catch (err) {
      console.error('Erro compras/historico-item:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
