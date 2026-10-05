// GET /cobranca/omni/contrato/:contrato  — detalhe (última posição) + histórico de ações. Perm 9007.
const { detalhe } = require('../../services/omniCarteira');
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([9007, 0]);

module.exports = (app) => ({
  verb: 'get',
  route: '/omni/contrato/:contrato',
  middlewares: [requirePerm(app)],
  handler: async (req, res) => {
    try {
      const r = await detalhe(app, req.params.contrato);
      if (!r.posicao && !r.trabalho) return res.status(404).json({ message: 'Contrato não encontrado.' });
      return res.json(r);
    } catch (e) {
      console.error('omni-contrato:', e.message);
      return res.status(500).json({ message: 'Erro ao carregar o contrato: ' + e.message });
    }
  }
});
