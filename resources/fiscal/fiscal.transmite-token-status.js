// GET /fiscal/transmite-token — status do token do Transmite (p/ a tela de
// renovação): tem token?, expira quando, expirado?, horas restantes, quem/quando
// atualizou. Perm 16001.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([16001, 0]);
const Transmite = require('../../services/transmite');

module.exports = (app) => ({
  verb: 'get',
  route: '/transmite-token',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    try {
      return res.json(await Transmite.statusToken());
    } catch (err) {
      console.error('fiscal/transmite-token status:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
