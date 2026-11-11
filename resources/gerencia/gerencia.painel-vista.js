// GET /gerencia/painel-vista — snapshot do Painel de Gestão à Vista (Pipefy).
// Perm 10004 (TVs usam usuário dedicado com só esta). Lê do ESPELHO no banco
// (services/pipefyPainel.js, migration 142): as TVs podem consultar de minuto
// em minuto sem gastar chamada do Pipefy — ele é lido só nos horários do scheduler.
// `historico` = série diária TOTAL dos últimos 30 dias (migration 137), para a
// tendência dos indicadores do topo. Muda só a cada leitura do Pipefy (3x/dia),
// então fica 5 min em cache: várias TVs não repetem a consulta.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([10004]);
const PipefyPainel = require('../../services/pipefyPainel');

const HIST_MS = 5 * 60000;
let histCache = null;
async function historicoTotal(Pg) {
  if (histCache && Date.now() - histCache.em < HIST_MS) return histCache.rows;
  const rows = await PipefyPainel.lerHistorico(Pg, 30, 'total');
  histCache = { rows, em: Date.now() };
  return rows;
}

module.exports = (app) => ({
  verb: 'get',
  route: '/painel-vista',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    try {
      const snap = await PipefyPainel.obterSnapshot(Pg);
      const historico = await historicoTotal(Pg);
      return res.json({ ...PipefyPainel.paraTv(snap), historico });
    } catch (err) {
      console.error('gerencia/painel-vista:', err);
      return res.status(502).json({ message: 'Falha ao montar o painel: ' + err.message });
    }
  }
});
