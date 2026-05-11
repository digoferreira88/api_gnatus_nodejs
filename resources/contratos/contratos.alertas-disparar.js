// POST /contratos/alertas/disparar — roda o cron de alertas agora (debug/teste).
// So admin universal (perm 0) pra evitar spam.
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([0]);
const ContratoAlertas = require('../../services/contratoAlertas');

module.exports = (app) => ({
  verb: 'post',
  route: '/alertas/disparar',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    try {
      const stats = await ContratoAlertas.rodarAlertas(app);
      return res.json({ ok: true, stats });
    } catch (err) {
      console.error('contratos/alertas-disparar:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
