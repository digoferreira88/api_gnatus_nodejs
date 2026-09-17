// GET /sac/kanban-config — SLA de cada etapa e parâmetros do Kanban de Pós-Venda.
// Perm 6004 (ver) ou 6005 (configurar). Rota fora de /kanban-pedidos/ para não
// colidir com /kanban-pedidos/:num.

const Kanban = require('../../services/kanbanPedidos');
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([6004, 6005]);

module.exports = (app) => ({
  verb: 'get',
  route: '/kanban-config',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    try {
      const cfg = await Kanban.carregarConfig(app);
      return res.json({
        sla: cfg.slaLista,
        curvaAValor: cfg.curvaAValor,
        periodoPadraoDias: cfg.periodoPadraoDias,
        amareloPct: cfg.amareloPct
      });
    } catch (err) {
      console.error('Erro sac/kanban-config:', err);
      return res.status(500).json({ message: 'Não foi possível carregar a configuração do Kanban.' });
    }
  }
});
