// Remove todas as linhas de uma NF do bordero
const trim = (v) => String(v || '').trim();

module.exports = (app) => ({
  verb: 'delete',
  route: '/bordero/nf/:nfe',
  middlewares: [require('../../middlewares/requirePerm')(app)([12001, 12002])],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const nfe = trim(req.params.nfe).toUpperCase();
    if (!nfe) return res.status(400).json({ message: 'NFe é obrigatória.' });
    try {
      await Pg.connectAndQuery(
        `DELETE FROM tab_exp_bordero WHERE NOTAFISCAL = @nfe`, { nfe }
      );
      return res.json({ ok: true });
    } catch (err) {
      console.error('Erro expedicao/bordero-delete-nf:', err);
      return res.status(500).json({ message: 'Erro ao remover NF do bordero.' });
    }
  }
});
