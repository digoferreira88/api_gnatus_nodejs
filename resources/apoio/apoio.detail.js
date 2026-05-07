// GET /apoio/apresentacoes/:id — retorna apresentacao salva (com perfil + dados).
// Permissao 5001. Nao-admin so ve as proprias.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([5001]);

module.exports = (app) => ({
  verb: 'get',
  route: '/apresentacoes/:id',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'id invalido.' });

    try {
      const rows = await Pg.connectAndQuery(`
        SELECT a.*, u.nome AS autor_nome
          FROM tab_apoio_apresentacao a
          LEFT JOIN tab_intranet_usr u ON u.id = a.id_user
         WHERE a.id = @id`, { id });
      if (!rows.length) return res.status(404).json({ message: 'Apresentacao nao encontrada.' });

      const a = rows[0];
      const isAdmin = await Pg.connectAndQuery(
        `SELECT 1 FROM tab_intranet_usr_permissoes WHERE id_user = @uid AND id_permissao = 0 LIMIT 1`,
        { uid: user.ID }
      );
      if (a.id_user !== user.ID && !isAdmin.length) {
        return res.status(403).json({ message: 'Sem permissao para ver esta apresentacao.' });
      }
      return res.json({ apresentacao: a });
    } catch (err) {
      console.error('apoio/detail:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
