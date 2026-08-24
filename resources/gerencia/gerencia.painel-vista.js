// GET /gerencia/painel-vista — snapshot do Painel de Gestão à Vista (Pipefy).
// Perm 10004 (TVs usam usuário dedicado com só esta). O serviço cacheia ~5 min;
// as TVs podem consultar de minuto em minuto sem custo de API do Pipefy.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([10004]);
const PipefyPainel = require('../../services/pipefyPainel');

module.exports = (app) => ({
  verb: 'get',
  route: '/painel-vista',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    if (!PipefyPainel.disponivel()) {
      return res.status(503).json({ message: 'PIPEFY_TOKEN não configurado no servidor.' });
    }
    try {
      const snap = await PipefyPainel.obterSnapshot(app.services.Pg);
      return res.json(snap);
    } catch (err) {
      console.error('gerencia/painel-vista:', err);
      return res.status(502).json({ message: 'Falha ao consultar o Pipefy: ' + err.message });
    }
  }
});
