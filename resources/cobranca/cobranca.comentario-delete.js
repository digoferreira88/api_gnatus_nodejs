// Remove comentário (apenas autor ou admin perm 0)
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([9001, 9002]);

module.exports = (app) => ({
  verb: 'delete',
  route: '/comentario/:id',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Usuário não autenticado.' });

    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ message: 'ID inválido.' });

    try {
      const existing = await Pg.connectAndQuery(
        `SELECT ID_USER FROM tab_cobranca_comentario WHERE ID = @id`, { id }
      );
      if (!existing.length) return res.status(404).json({ message: 'Comentário não encontrado.' });

      // Admin = perm 0 (nao mais por string de email)
      const isAdmin = await Pg.connectAndQuery(
        `SELECT 1 FROM tab_intranet_usr_permissoes WHERE id_user = @id AND id_permissao = 0 LIMIT 1`,
        { id: user.ID }
      );
      if (existing[0].ID_USER !== user.ID && isAdmin.length === 0) {
        return res.status(403).json({ message: 'Sem permissão para excluir este comentário.' });
      }
      await Pg.connectAndQuery(`DELETE FROM tab_cobranca_comentario WHERE ID = @id`, { id });
      return res.json({ ok: true });
    } catch (err) {
      console.error('Erro cobranca/comentario-delete:', err);
      return res.status(500).json({ message: 'Erro ao excluir comentário.' });
    }
  }
});
