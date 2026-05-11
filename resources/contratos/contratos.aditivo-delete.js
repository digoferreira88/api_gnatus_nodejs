// DELETE /contratos/:id/aditivos/:aid — exclui aditivo (so se RASCUNHO).
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([5003]);
const Auditoria = require('../../services/auditoria');

module.exports = (app) => ({
  verb: 'delete',
  route: '/:id/aditivos/:aid',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const id  = Number(req.params.id);
    const aid = Number(req.params.aid);
    try {
      const r = await Pg.connectAndQuery(
        `SELECT id, numero, tipo, status FROM tab_contrato_aditivo WHERE id = @aid AND id_contrato = @id`,
        { aid, id }
      );
      if (!r.length) return res.status(404).json({ message: 'Aditivo nao encontrado.' });
      if (r[0].status === 'APROVADO') return res.status(409).json({ message: 'Aditivo aprovado nao pode ser excluido. Cancele-o em vez disso.' });

      await Pg.connectAndQuery(`DELETE FROM tab_contrato_aditivo WHERE id = @aid`, { aid });

      Auditoria.registrar(app, {
        modulo: 'ApoioGerencial', submodulo: 'Contratos',
        acao: 'ADITIVO_DELETE', severidade: 'INFO',
        req, entidade: 'contrato_aditivo', entidadeId: String(aid),
        descricao: `Excluiu aditivo ${r[0].numero}/${r[0].tipo} do contrato ${id}`
      });
      return res.json({ ok: true });
    } catch (err) {
      console.error('aditivo-delete:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
