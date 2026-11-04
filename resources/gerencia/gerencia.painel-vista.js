// GET /gerencia/painel-vista — snapshot do Painel de Gestão à Vista (Pipefy).
// Perm 10004 (TVs usam usuário dedicado com só esta). Lê do ESPELHO no banco
// (services/pipefyPainel.js, migration 142): as TVs podem consultar de minuto
// em minuto sem gastar chamada do Pipefy — ele é lido só nos horários do scheduler.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([10004]);
const PipefyPainel = require('../../services/pipefyPainel');

module.exports = (app) => ({
  verb: 'get',
  route: '/painel-vista',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    try {
      const snap = await PipefyPainel.obterSnapshot(app.services.Pg);
      return res.json(PipefyPainel.paraTv(snap));
    } catch (err) {
      console.error('gerencia/painel-vista:', err);
      return res.status(502).json({ message: 'Falha ao montar o painel: ' + err.message });
    }
  }
});
