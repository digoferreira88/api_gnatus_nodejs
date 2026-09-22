// POST /integracao/clientes-pipefy/seed — registra (uma vez) quem já existe na
// database CLIENTES do Pipefy, casando por CÓDIGO, p/ o espelho NÃO recriar
// registro duplicado. Custa ~1 leitura a cada 50 registros (~235 p/ 11.745).
// Idempotente (pode rodar de novo). Perm 1033 / 0.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1033, 0]);
const PipefyClientes = require('../../services/pipefyClientes');

module.exports = (app) => ({
  verb: 'post',
  route: '/clientes-pipefy/seed',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    if (!require('../../services/pipefyClientes').TABLE_ID()) {
      return res.status(409).json({ message: 'PIPEFY_TABELA_CLIENTES não configurado.' });
    }
    if (!process.env.PIPEFY_TOKEN) {
      return res.status(409).json({ message: 'PIPEFY_TOKEN não configurado no .env.' });
    }
    try {
      const r = await PipefyClientes.seed({ Pg, Protheus });
      return res.json({ ok: true, ...r });
    } catch (err) {
      console.error('Erro clientes-pipefy/seed:', err);
      return res.status(502).json({ message: 'Erro no seed: ' + err.message });
    }
  }
});
