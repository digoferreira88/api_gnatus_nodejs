module.exports = (app) => ({
  verb: 'post',
  route: '/:id/toggle-active',
  middlewares: [require('../../middlewares/requirePerm')(app)([1028])],  // 1028 = Gestao Usuarios

  handler: async (req, res) => {
    const { Pg } = app.services;
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) return res.status(400).json({ message: 'ID inválido.' });

    try {
      await Pg.connectAndQuery(
        `UPDATE tab_intranet_usr
            SET ativo = NOT ativo
          WHERE id = @id`,
        { id }
      );
      const atual = await Pg.connectAndQuery(
        `SELECT ativo FROM tab_intranet_usr WHERE id = @id`,
        { id }
      );
      return res.json({ ok: true, ativo: !!atual[0]?.ativo });
    } catch (err) {
      console.error('Erro ao alternar ativo:', err);
      return res.status(500).json({ message: 'Erro ao alternar status.' });
    }
  }
});
