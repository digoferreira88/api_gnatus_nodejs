// GET /controladoria/pt/finalidades — lookup de sugestoes de finalidade.
// Permissao 11003.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([11003]);

module.exports = (app) => ({
  verb: 'get',
  route: '/pt/finalidades',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    try {
      const r = await Pg.connectAndQuery(
        `SELECT codigo, nome FROM tab_pt_finalidade WHERE ativo = true ORDER BY ordem, nome`, {}
      );
      return res.json({ finalidades: r });
    } catch (err) {
      console.error('pt-finalidades:', err);
      return res.status(500).json({ message: 'Erro ao listar finalidades.' });
    }
  }
});
