// POST /cobranca/whatsapp-disparar — roda o cron na hora (force=true ignora flag).
// Body opcional: { force: true } — pra teste/repique manual sem precisar ligar a automacao.
// Permissao 1030.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1030]);

module.exports = (app) => ({
  verb: 'post',
  route: '/whatsapp-disparar',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const Scheduler = require('../../services/scheduler');
    const force = req.body?.force === true;
    try {
      const stats = await Scheduler.rodarDisparo(app, { force });
      return res.json({ ok: true, ...stats });
    } catch (err) {
      console.error('whatsapp-disparar:', err);
      return res.status(500).json({ message: 'Erro ao executar disparo: ' + err.message });
    }
  }
});
