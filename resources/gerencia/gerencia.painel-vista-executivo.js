// GET /gerencia/painel-vista/executivo — Visão Executiva do Painel de Gestão à
// Vista (diretoria). Mesmo retrato da TV, lido do espelho do Pipefy no banco
// (zero chamada ao Pipefy por acesso), + a lista enxuta de cards abertos, que a
// tela filtra e agrega no navegador, + o histórico diário (migration 137) para a
// tendência. Perm 10004.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([10004]);
const PipefyPainel = require('../../services/pipefyPainel');

module.exports = (app) => ({
  verb: 'get',
  route: '/painel-vista/executivo',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    try {
      const snap = await PipefyPainel.obterSnapshot(Pg);
      const historico = await PipefyPainel.lerHistorico(Pg, 120);
      const { responsaveis, topAtrasados, porResponsavel, porSetor, ...resto } = snap;
      return res.json({ ...resto, historico });
    } catch (err) {
      console.error('gerencia/painel-vista/executivo:', err);
      return res.status(502).json({ message: 'Falha ao montar o painel: ' + err.message });
    }
  }
});
