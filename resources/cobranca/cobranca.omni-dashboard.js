// GET /cobranca/omni/dashboard?tipo=  — recuperação + envelhecimento da carteira. Perm 9007.
const { dashboard } = require('../../services/omniCarteira');
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([9007, 0]);

module.exports = (app) => ({
  verb: 'get',
  route: '/omni/dashboard',
  middlewares: [requirePerm(app)],
  handler: async (req, res) => {
    try {
      const r = await dashboard(app, { tipo: (req.query.tipo || 'CARTEIRA').toUpperCase() });
      return res.json(r);
    } catch (e) {
      console.error('omni-dashboard:', e.message);
      return res.status(500).json({ message: 'Erro ao montar o dashboard: ' + e.message });
    }
  }
});
