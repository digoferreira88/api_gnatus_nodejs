// DELETE /contratos/:id/anexos/:anexoId
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([5003]);
const Auditoria = require('../../services/auditoria');

module.exports = (app) => ({
  verb: 'delete',
  route: '/:id/anexos/:anexoId',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const id = Number(req.params.id);
    const anexoId = Number(req.params.anexoId);
    try {
      const r = await Pg.connectAndQuery(
        `DELETE FROM tab_contrato_anexo WHERE id = @aid AND id_contrato = @cid RETURNING nome_arquivo`,
        { aid: anexoId, cid: id }
      );
      if (!r.length) return res.status(404).json({ message: 'Anexo nao encontrado.' });
      Auditoria.registrar(app, {
        modulo: 'ApoioGerencial', submodulo: 'Contratos',
        acao: 'DELETE_ANEXO', severidade: 'INFO',
        req, entidade: 'contrato', entidadeId: String(id),
        descricao: `Removeu anexo "${r[0].nome_arquivo}" do contrato ${id}`
      });
      return res.json({ ok: true });
    } catch (err) {
      console.error('contratos/anexo-delete:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
