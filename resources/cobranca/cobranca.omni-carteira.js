// GET /cobranca/omni/carteira?tipo=&faixa=&status=&score=&semAcionamento=&q=
// Carteira atual (última importação) + camada de trabalho por contrato. Perm 9007.
const { listarCarteira } = require('../../services/omniCarteira');
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([9007, 0]);

module.exports = (app) => ({
  verb: 'get',
  route: '/omni/carteira',
  middlewares: [requirePerm(app)],
  handler: async (req, res) => {
    try {
      const r = await listarCarteira(app, {
        tipo: (req.query.tipo || 'CARTEIRA').toUpperCase(),
        faixa: req.query.faixa, status: req.query.status, score: req.query.score,
        semAcionamento: req.query.semAcionamento, q: req.query.q
      });
      return res.json(r);
    } catch (e) {
      console.error('omni-carteira:', e.message);
      return res.status(500).json({ message: 'Erro ao carregar a carteira: ' + e.message });
    }
  }
});
