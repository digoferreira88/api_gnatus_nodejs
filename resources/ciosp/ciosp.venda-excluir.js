// DELETE /ciosp/vendas/:id — remove uma venda do CIOSP. Perm 19002. Auditoria.
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([19002, 0]);
const Auditoria = require('../../services/auditoria');

module.exports = (app) => ({
  verb: 'delete',
  route: '/vendas/:id',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ message: 'id inválido.' });
    try {
      const del = await Pg.connectAndQuery(
        `DELETE FROM tab_ciosp_venda WHERE id=@id RETURNING cliente, categoria, valor`, { id });
      if (!del.length) return res.status(404).json({ message: 'Venda não encontrada.' });

      Auditoria.registrar(app, {
        modulo: 'CIOSP', submodulo: 'Vendas', acao: 'EXCLUIR', severidade: 'AVISO',
        req, entidade: 'venda', entidadeId: String(id),
        descricao: `Excluiu venda CIOSP #${id} — ${del[0].cliente} (${del[0].categoria}) · R$ ${del[0].valor}`
      });
      return res.json({ ok: true, id });
    } catch (err) {
      console.error('ciosp/venda-excluir:', err.message);
      return res.status(500).json({ message: 'Erro ao excluir venda: ' + err.message });
    }
  }
});
