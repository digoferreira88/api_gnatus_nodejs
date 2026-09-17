// GET /sac/kanban-pedidos/:num — detalhe de um pedido no Kanban de Pós-Venda:
// linha do tempo das etapas (entrada, saída, duração, SLA), itens e notas com
// expedição, rastreio e entrega. Perm 6004 ou 6005.

const Kanban = require('../../services/kanbanPedidos');
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([6004, 6005]);

module.exports = (app) => ({
  verb: 'get',
  route: '/kanban-pedidos/:num',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const num = String(req.params.num || '').replace(/\D/g, '');
    if (!num || num.length > 6) return res.status(400).json({ message: 'Informe o número do pedido (até 6 dígitos).' });
    try {
      const det = await Kanban.detalharPedido(app, num);
      if (!det) return res.status(404).json({ message: `Pedido ${num.padStart(6, '0')} não encontrado entre os pedidos de venda da filial 01.` });
      if (det.cancelado) return res.status(404).json({ message: `Pedido ${det.num} tem todos os itens com resíduo eliminado (cancelado).` });
      return res.json(det);
    } catch (err) {
      console.error('Erro sac/kanban-pedidos/:num:', err);
      return res.status(500).json({ message: 'Não foi possível carregar o pedido. Tente de novo em instantes.' });
    }
  }
});
