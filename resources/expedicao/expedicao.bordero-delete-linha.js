// Remove uma linha específica (um volume) do bordero
module.exports = (app) => ({
  verb: 'delete',
  route: '/bordero/:id',
  middlewares: [require('../../middlewares/requirePerm')(app)([12001, 12002])],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ message: 'ID inválido.' });
    try {
      await Pg.connectAndQuery(`DELETE FROM tab_exp_bordero WHERE ID = @id`, { id });
      return res.json({ ok: true });
    } catch (err) {
      console.error('Erro expedicao/bordero-delete-linha:', err);
      return res.status(500).json({ message: 'Erro ao remover linha.' });
    }
  }
});
