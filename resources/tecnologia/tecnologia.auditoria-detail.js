// GET /tecnologia/auditoria/:id — detalhe completo de um log (com antes/depois/meta).
// Perm 1032.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1032]);

module.exports = (app) => ({
  verb: 'get',
  route: '/auditoria/:id',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'id invalido.' });
    try {
      const r = await Pg.connectAndQuery(`SELECT * FROM tab_auditoria WHERE id = @id`, { id });
      if (!r.length) return res.status(404).json({ message: 'Log nao encontrado.' });
      return res.json({ log: r[0] });
    } catch (err) {
      console.error('auditoria detail:', err);
      return res.status(500).json({ message: 'Erro ao buscar log.' });
    }
  }
});
