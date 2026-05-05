// GET /controladoria/pt/envios/:id — detalhes (cabecalho + itens + finalizacoes).
// Permissao 11003.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([11003]);

module.exports = (app) => ({
  verb: 'get',
  route: '/pt/envios/:id',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ message: 'id invalido.' });
    }
    try {
      const cab = await Pg.connectAndQuery(`SELECT * FROM tab_pt_envio WHERE id = @id`, { id });
      if (!cab.length) return res.status(404).json({ message: 'Envio nao encontrado.' });

      const itens = await Pg.connectAndQuery(
        `SELECT * FROM tab_pt_envio_item WHERE envio_id = @id ORDER BY ordem, id`, { id }
      );
      const finalizacoes = await Pg.connectAndQuery(
        `SELECT * FROM tab_pt_finalizacao WHERE envio_id = @id ORDER BY data_finalizacao DESC, id DESC`, { id }
      );

      return res.json({ envio: cab[0], itens, finalizacoes });
    } catch (err) {
      console.error('pt-detail:', err);
      return res.status(500).json({ message: 'Erro ao buscar envio.' });
    }
  }
});
