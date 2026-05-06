// DELETE /tecnologia/protheus-import/layouts/:id — remove (dono ou admin).
// Permissao 1031.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1031]);

module.exports = (app) => ({
  verb: 'delete',
  route: '/protheus-import/layouts/:id',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'id invalido.' });

    try {
      // Checa permissao admin (perm 0) — admin pode deletar qualquer
      const adminCheck = await Pg.connectAndQuery(
        `SELECT 1 FROM tab_intranet_usr_permissoes WHERE id_user = @uid AND id_permissao = 0 LIMIT 1`,
        { uid: user.ID }
      );
      const isAdmin = adminCheck.length > 0;

      const dono = await Pg.connectAndQuery(
        `SELECT criado_por FROM tab_protheus_import_layout WHERE id = @id`, { id }
      );
      if (!dono.length) return res.status(404).json({ message: 'Layout nao encontrado.' });
      if (!isAdmin && Number(dono[0].criado_por) !== Number(user.ID)) {
        return res.status(403).json({ message: 'Apenas o dono ou admin pode remover.' });
      }

      await Pg.connectAndQuery(`DELETE FROM tab_protheus_import_layout WHERE id = @id`, { id });
      return res.json({ ok: true });
    } catch (err) {
      console.error('protheus-import-layout delete:', err);
      return res.status(500).json({ message: 'Erro ao remover layout: ' + err.message });
    }
  }
});
