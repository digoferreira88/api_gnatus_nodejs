// DELETE /planejamento/controle/:pedido — remove um pedido do controle. Perm 3003.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([3003]);
const Auditoria = require('../../services/auditoria');
const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'delete',
  route: '/controle/:pedido',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const pedido = trim(req.params.pedido);
    if (!pedido) return res.status(400).json({ message: 'pedido obrigatório.' });
    try {
      const del = await Pg.connectAndQuery(
        `DELETE FROM tab_plan_controle WHERE filial='01' AND pedido=@ped RETURNING id`, { ped: pedido });
      if (!del.length) return res.status(404).json({ message: 'Pedido não está no controle.' });
      Auditoria.registrar(app, {
        modulo: 'Planejamento', submodulo: 'ControleFaturamento', acao: 'REMOVER_CONTROLE', severidade: 'ALERTA', req,
        entidade: 'pedido', entidadeId: pedido, descricao: `Removeu pedido ${pedido} do controle`, meta: {}
      });
      return res.json({ ok: true, pedido });
    } catch (err) {
      console.error('Erro controle-remover:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
