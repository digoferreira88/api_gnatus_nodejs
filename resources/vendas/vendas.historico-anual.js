// Vendas Historicas: matriz produto x ano (qtd e valor por ano).
// Migrado de Vendas/reportVendasHistoricas do intranet antigo.
//
// Usa view customizada FATURAMENTO_ITEM no Protheus (CODIGO, ANO, QTD, VALOR).
//
// GET /vendas/historico-anual?anoMin=&anoMax=&busca=

const trim = (v) => v == null ? null : String(v).trim();
const toN  = (v) => Number(v || 0);

module.exports = (app) => ({
  verb: 'get',
  route: '/historico-anual',
  middlewares: [require('../../middlewares/requirePerm')(app)([2004, 2002])],

  handler: async (req, res) => {
    const { Protheus } = app.services;

    const anoAtual = new Date().getFullYear();
    const anoMin = Number(req.query.anoMin) || (anoAtual - 4);
    const anoMax = Number(req.query.anoMax) || anoAtual;
    const busca  = trim(req.query.busca);

    const params = { anoMin: String(anoMin), anoMax: String(anoMax) };
    let condBusca = '';
    if (busca) {
      condBusca = `AND (sb1.B1_COD LIKE @busca OR sb1.B1_DESC LIKE @busca)`;
      params.busca = `%${busca}%`;
    }

    try {
      const rows = await Protheus.connectAndQuery(`
        SELECT RTRIM(fi.CODIGO) codigo,
               RTRIM(sb1.B1_DESC) descricao,
               RTRIM(sb1.B1_TIPO) tipo,
               fi.ANO ano,
               fi.QTD qtd,
               fi.VALOR valor
          FROM FATURAMENTO_ITEM fi
          LEFT JOIN SB1010 sb1 WITH (NOLOCK) ON fi.CODIGO = sb1.B1_COD AND sb1.D_E_L_E_T_ <> '*'
         WHERE fi.ANO BETWEEN @anoMin AND @anoMax
           ${condBusca}
         ORDER BY sb1.B1_DESC, fi.ANO`,
        params
      );

      // Reorganiza em matriz: produto -> { codigo, descricao, tipo, anos: { 2024: {qtd,valor}, ... } }
      const map = new Map();
      const anosSet = new Set();
      rows.forEach(r => {
        const cod = trim(r.codigo);
        const ano = String(r.ano);
        anosSet.add(ano);
        if (!map.has(cod)) {
          map.set(cod, {
            codigo: cod,
            descricao: trim(r.descricao),
            tipo: trim(r.tipo),
            anos: {},
            totalQtd: 0,
            totalValor: 0
          });
        }
        const item = map.get(cod);
        item.anos[ano] = { qtd: toN(r.qtd), valor: toN(r.valor) };
        item.totalQtd += toN(r.qtd);
        item.totalValor += toN(r.valor);
      });

      const anos = Array.from(anosSet).sort();
      const itens = Array.from(map.values()).sort((a, b) => b.totalValor - a.totalValor);

      return res.json({
        filtro: { anoMin, anoMax, busca: busca || null },
        anos,
        total: itens.length,
        itens,
        geradoEm: new Date().toISOString()
      });
    } catch (err) {
      console.error('Erro vendas/historico-anual:', err);
      return res.status(500).json({
        message: 'Erro: ' + err.message + ' (verificar se a view FATURAMENTO_ITEM existe no Protheus)'
      });
    }
  }
});
