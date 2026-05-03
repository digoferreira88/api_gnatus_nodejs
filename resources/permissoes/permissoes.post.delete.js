module.exports = app => ({
  verb: "post",
  route: "/delete/:ID",
  middlewares: [require('../../middlewares/requirePerm')(app)([1026])],  // 1026 = Gerenciamento Permissoes

 handler: async (req, res) => {
    const { Pg } = app.services;
    const { ID } = req.params;

    const id = parseInt(ID, 10);
    if (!id || isNaN(id)) {
      return res.status(400).json({ message: "ID inválido ou não informado." });
    }

    try {
      const result = await Pg.connectAndQuery(
        `DELETE FROM tab_intranet_permissoes WHERE ID = @id`,
        { id }
      );
      if (result && result.rowsAffected && result.rowsAffected[0] === 0) {
        return res.status(404).json({ message: "Permissão não encontrada." });
      }

      return res.status(200).json({ message: "Permissão excluída com sucesso." });
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  }
});
