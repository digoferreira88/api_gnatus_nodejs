// PUT /cobranca/omni/contrato/:contrato  — grava status/tags/agendamento/observação do contrato
// e registra no histórico de ações. Body: { status?, tags?[], agendamentoData?, agendamentoObs?, observacao? }.
// Perm 9007 (todos da cobrança operam; registra quem fez).
const { salvarTrabalho } = require('../../services/omniCarteira');
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([9007, 0]);

module.exports = (app) => ({
  verb: 'put',
  route: '/omni/contrato/:contrato',
  middlewares: [requirePerm(app)],
  handler: async (req, res) => {
    const user = req.user && req.user[0];
    const b = req.body || {};
    try {
      const r = await salvarTrabalho(app, {
        contrato: req.params.contrato,
        status: b.status, tags: b.tags,
        agendamentoData: b.agendamentoData, agendamentoObs: b.agendamentoObs,
        observacao: b.observacao, user
      });
      if (!r.ok) return res.status(r.erro === 'NAO_ENCONTRADO' ? 404 : 400).json(r);
      return res.json(r);
    } catch (e) {
      console.error('omni-trabalho:', e.message);
      return res.status(500).json({ message: 'Erro ao salvar: ' + e.message });
    }
  }
});
