// DELETE /gerencia/cc-orcamento/:id
// Remove um orcamento cadastrado por id.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([10001]);

module.exports = (app) => ({
  verb: 'delete',
  route: '/cc-orcamento/:id',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ message: 'id invalido.' });

    try {
      const rows = await Pg.connectAndQuery(
        `DELETE FROM tab_centro_custo_orcamento WHERE id = @id RETURNING id`,
        { id });
      if (!rows.length) return res.status(404).json({ message: 'Orcamento nao encontrado.' });
      return res.json({ ok: true, id: rows[0].id });
    } catch (err) {
      console.error('cc-orcamento-remover:', err);
      return res.status(500).json({ message: 'Erro ao remover orcamento: ' + err.message });
    }
  }
});
