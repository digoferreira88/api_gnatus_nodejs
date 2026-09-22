// GET /integracao/clientes-pipefy/status — panorama do espelho SA1 -> Pipefy
// CLIENTES: ligado?, seed feito?, quantos sincronizados/faltando/órfãos, uso do
// dia vs teto, e os últimos ciclos. Perm 1033 (integrações Pipefy) / 0 (admin).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1033, 0]);
const PipefyClientes = require('../../services/pipefyClientes');

module.exports = (app) => ({
  verb: 'get',
  route: '/clientes-pipefy/status',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    try {
      const panorama = await PipefyClientes.panorama({ Pg, Protheus });
      const logs = await PipefyClientes.ultimosLogs(Pg, 15);
      return res.json({ ...panorama, logs });
    } catch (err) {
      console.error('Erro clientes-pipefy/status:', err);
      return res.status(500).json({ message: 'Erro ao ler status: ' + err.message });
    }
  }
});
