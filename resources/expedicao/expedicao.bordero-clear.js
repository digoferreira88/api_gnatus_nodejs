// Limpa o bordero inteiro
module.exports = (app) => ({
  verb: 'delete',
  route: '/bordero',
  middlewares: [require('../../middlewares/requirePerm')(app)([12001, 12002])],

  handler: async (req, res) => {
    const { Pg } = app.services;
    try {
      await Pg.connectAndQuery(`DELETE FROM tab_exp_bordero`, {});
      return res.json({ ok: true });
    } catch (err) {
      console.error('Erro expedicao/bordero-clear:', err);
      return res.status(500).json({ message: 'Erro ao limpar bordero.' });
    }
  }
});
