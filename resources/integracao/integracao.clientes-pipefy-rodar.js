// POST /integracao/clientes-pipefy/rodar — dispara um ciclo do espelho agora
// (respeita os tetos diário/ciclo). Útil p/ a gestão empurrar o backfill ou
// aplicar um cliente novo na hora. Perm 1033 / 0.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1033, 0]);
const PipefyClientes = require('../../services/pipefyClientes');

module.exports = (app) => ({
  verb: 'post',
  route: '/clientes-pipefy/rodar',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    if (!PipefyClientes.disponivel()) {
      return res.status(409).json({ message: 'Espelho inativo — defina PIPEFY_TOKEN e PIPEFY_CLIENTES_ATIVO=1 no .env.' });
    }
    try {
      const r = await PipefyClientes.sincronizar({ Pg, Protheus }, 'MANUAL');
      return res.json({ ok: true, ...r });
    } catch (err) {
      console.error('Erro clientes-pipefy/rodar:', err);
      return res.status(500).json({ message: 'Erro ao rodar: ' + err.message });
    }
  }
});
