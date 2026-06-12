// GET /integracao/op-pipefy-tabelas — lista as tabelas da organizacao no
// Pipefy (p/ descobrir o id da tabela de produtos e configurar
// PIPEFY_TABELA_PRODUTOS no .env). Perm 1033.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1033]);
const PipefyOp = require('../../services/pipefyOp');

module.exports = (app) => ({
  verb: 'get',
  route: '/op-pipefy-tabelas',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    if (!PipefyOp.disponivel()) return res.status(409).json({ message: 'PIPEFY_TOKEN não configurado no .env.' });
    try {
      const tabelas = await PipefyOp.listarTabelas();
      return res.json({ tabelas, tabelaConfigurada: PipefyOp.TABELA_PRODUTOS() || null });
    } catch (err) {
      console.error('Erro op-pipefy-tabelas:', err);
      return res.status(502).json({ message: 'Erro ao consultar Pipefy: ' + err.message });
    }
  }
});
