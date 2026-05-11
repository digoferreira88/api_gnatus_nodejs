// DELETE /contratos/:id — exclui contrato (cascade nos aditivos/anexos/alertas)
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([5003]);
const Auditoria = require('../../services/auditoria');

module.exports = (app) => ({
  verb: 'delete',
  route: '/:id',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'id invalido.' });
    try {
      const cur = await Pg.connectAndQuery(`SELECT id, numero, titulo, contraparte_nome FROM tab_contrato WHERE id = @id`, { id });
      if (!cur.length) return res.status(404).json({ message: 'Contrato nao encontrado.' });
      const c = cur[0];

      await Pg.connectAndQuery(`DELETE FROM tab_contrato WHERE id = @id`, { id });

      Auditoria.registrar(app, {
        modulo: 'ApoioGerencial', submodulo: 'Contratos',
        acao: 'DELETE', severidade: 'ALERTA',
        req, entidade: 'contrato', entidadeId: String(id),
        descricao: `Excluiu contrato ${c.numero} — ${c.titulo} (${c.contraparte_nome})`,
        antes: c
      });
      return res.json({ ok: true });
    } catch (err) {
      console.error('contratos/delete:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
