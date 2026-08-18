// GET /planejamento/forecast/dashboard?ano=YYYY
// Consolida PREVISTO × REALIZADO por produto/mês somando as carteiras com
// consolidar=TRUE (evita a dupla contagem TOTAL×detalhe da planilha). Perm 18002.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([18002, 0]);
const Realizado = require('../../services/forecastRealizado');

const zeros = () => Array.from({ length: 12 }, () => 0);

module.exports = (app) => ({
  verb: 'get',
  route: '/forecast/dashboard',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const ano = Number(req.query.ano) || new Date().getFullYear();

    try {
      const produtos = await Pg.connectAndQuery(
        `SELECT codigo, descricao, ordem FROM tab_forecast_produto WHERE ativo ORDER BY ordem, codigo`);
      const carteiras = await Pg.connectAndQuery(
        `SELECT id, nome, vendedor_cods, ufs FROM tab_forecast_carteira WHERE ativo AND consolidar ORDER BY ordem`);

      // PREVISTO consolidado (soma das carteiras consolidar) por produto/mês
      const prevRows = await Pg.connectAndQuery(
        `SELECT p.produto_cod, p.mes, SUM(p.qtd)::int qtd
           FROM tab_forecast_previsao p
           JOIN tab_forecast_carteira c ON c.id = p.carteira_id AND c.ativo AND c.consolidar
          WHERE p.ano = @a
          GROUP BY p.produto_cod, p.mes`, { a: ano });
      const mapPrev = {};
      prevRows.forEach(r => { (mapPrev[r.produto_cod] || (mapPrev[r.produto_cod] = {}))[r.mes] = Number(r.qtd) || 0; });

      // PREVISTO por carteira (para o comparativo por vendedor)
      const prevCartRows = await Pg.connectAndQuery(
        `SELECT carteira_id, SUM(qtd)::int qtd FROM tab_forecast_previsao
          WHERE ano=@a GROUP BY carteira_id`, { a: ano });
      const prevPorCarteira = {};
      prevCartRows.forEach(r => { prevPorCarteira[r.carteira_id] = Number(r.qtd) || 0; });

      // REALIZADO consolidado — soma o realizado de cada carteira consolidar
      const mapReal = {};                 // produto(norm) -> {mes: qtd}
      const realPorCarteira = {};         // carteira_id -> total
      for (const c of carteiras) {
        let m = {};
        try { m = await Realizado.realizado({ ano, vendedorCods: c.vendedor_cods, ufs: c.ufs }); }
        catch (e) { console.error('forecast/dashboard realizado', c.nome, e.message); }
        let tot = 0;
        for (const cod of Object.keys(m)) {
          const alvo = (mapReal[cod] || (mapReal[cod] = {}));
          for (const [mes, q] of Object.entries(m[cod])) { alvo[mes] = (alvo[mes] || 0) + q; tot += q; }
        }
        realPorCarteira[c.id] = tot;
      }

      // monta linhas por produto + totais
      const totMesPrev = zeros(), totMesReal = zeros();
      const linhas = produtos.map(pr => {
        const rk = mapReal[Realizado.normCod(pr.codigo)] || {};
        const pk = mapPrev[pr.codigo] || {};
        const previsto = zeros(), realizado = zeros();
        for (let i = 1; i <= 12; i++) {
          previsto[i - 1] = pk[i] || 0; realizado[i - 1] = rk[i] || 0;
          totMesPrev[i - 1] += previsto[i - 1]; totMesReal[i - 1] += realizado[i - 1];
        }
        return {
          codigo: pr.codigo, descricao: pr.descricao,
          previsto, realizado,
          totalPrev: previsto.reduce((a, b) => a + b, 0),
          totalReal: realizado.reduce((a, b) => a + b, 0)
        };
      });

      return res.json({
        ano,
        linhas,
        totaisMes: { previsto: totMesPrev, realizado: totMesReal },
        totalGeral: { previsto: totMesPrev.reduce((a, b) => a + b, 0), realizado: totMesReal.reduce((a, b) => a + b, 0) },
        porCarteira: carteiras.map(c => ({
          id: c.id, nome: c.nome,
          previsto: prevPorCarteira[c.id] || 0,
          realizado: realPorCarteira[c.id] || 0
        })),
        geradoEm: new Date().toISOString()
      });
    } catch (err) {
      console.error('forecast/dashboard:', err);
      return res.status(500).json({ message: 'Erro ao montar o dashboard.' });
    }
  }
});
