// GET /planejamento/forecast/grid?carteira=ID&ano=YYYY
// Monta o grid de uma carteira: por produto, PREVISÃO (tab_forecast_previsao) +
// REALIZADO (Protheus, via forecastRealizado) de cada um dos 12 meses.
// Vendedor só vê a carteira dele; gestão vê qualquer uma. Perm 18001/18002.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([18001, 18002, 0]);
const Acesso = require('../../services/forecastAcesso');
const Realizado = require('../../services/forecastRealizado');

module.exports = (app) => ({
  verb: 'get',
  route: '/forecast/grid',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Não autenticado.' });

    const carteiraId = Number(req.query.carteira);
    const ano = Number(req.query.ano) || new Date().getFullYear();
    if (!Number.isInteger(carteiraId) || carteiraId <= 0) return res.status(400).json({ message: 'carteira inválida.' });

    try {
      const gestao = await Acesso.ehGestao(Pg, user.ID);
      const { cart, pode } = await Acesso.carteiraSePode(Pg, user.ID, gestao, carteiraId);
      if (!cart) return res.status(404).json({ message: 'Carteira não encontrada.' });
      if (!pode) return res.status(403).json({ message: 'Sem acesso a esta carteira.' });

      // aberto p/ edição?
      const cfg = (await Pg.connectAndQuery(`SELECT aberto FROM tab_forecast_config WHERE ano=@a`, { a: ano }))[0];
      const aberto = cfg ? !!cfg.aberto : true;

      // produtos (lista-mestra)
      const produtos = await Pg.connectAndQuery(
        `SELECT codigo, descricao, ordem FROM tab_forecast_produto WHERE ativo ORDER BY ordem, codigo`);

      // previsão salva
      const prev = await Pg.connectAndQuery(
        `SELECT produto_cod, mes, qtd FROM tab_forecast_previsao WHERE ano=@a AND carteira_id=@c`,
        { a: ano, c: carteiraId });
      const mapPrev = {};
      prev.forEach(p => { (mapPrev[p.produto_cod] || (mapPrev[p.produto_cod] = {}))[p.mes] = Number(p.qtd) || 0; });

      // realizado do Protheus
      let mapReal = {};
      try {
        mapReal = await Realizado.realizado({ ano, vendedorCods: cart.vendedor_cods, ufs: cart.ufs });
      } catch (e) { console.error('forecast/grid realizado:', e.message); }

      const linhas = produtos.map(pr => {
        const previsao = Array.from({ length: 12 }, (_, i) => (mapPrev[pr.codigo] || {})[i + 1] || 0);
        const rk = mapReal[Realizado.normCod(pr.codigo)] || {};
        const realizado = Array.from({ length: 12 }, (_, i) => rk[i + 1] || 0);
        return {
          codigo: pr.codigo, descricao: pr.descricao,
          previsao, realizado,
          totalPrev: previsao.reduce((a, b) => a + b, 0),
          totalReal: realizado.reduce((a, b) => a + b, 0)
        };
      });

      return res.json({
        carteira: { id: cart.id, nome: cart.nome, vendedorCods: cart.vendedor_cods || '', ufs: cart.ufs || '', temVendedor: !!String(cart.vendedor_cods || '').trim() },
        ano, aberto, editavel: pode && aberto,
        linhas
      });
    } catch (err) {
      console.error('forecast/grid:', err);
      return res.status(500).json({ message: 'Erro ao montar o grid.' });
    }
  }
});
