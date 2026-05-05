// DELETE /controladoria/pt/envios/:id — remove envio (cascata em itens/finalizacoes).
// Permissao 11003.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([11003]);

module.exports = (app) => ({
  verb: 'delete',
  route: '/pt/envios/:id',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'id invalido.' });
    try {
      await Pg.connectAndQuery(`DELETE FROM tab_pt_envio WHERE id = @id`, { id });
      return res.json({ ok: true });
    } catch (err) {
      console.error('pt-delete:', err);
      return res.status(500).json({ message: 'Erro ao remover envio: ' + err.message });
    }
  }
});
