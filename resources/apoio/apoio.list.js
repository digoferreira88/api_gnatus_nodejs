// GET /apoio/apresentacoes — lista historico de apresentacoes geradas.
// Permissao 5001. Usuario admin ve todas, demais veem soh as proprias.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([5001]);

module.exports = (app) => ({
  verb: 'get',
  route: '/apresentacoes',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);
    const offset = Math.max(Number(req.query.offset || 0), 0);

    // Verifica se eh admin (perm 0) — admin ve tudo
    const isAdmin = await Pg.connectAndQuery(
      `SELECT 1 FROM tab_intranet_usr_permissoes WHERE id_user = @uid AND id_permissao = 0 LIMIT 1`,
      { uid: user.ID }
    );
    const filtroUser = isAdmin.length ? '' : 'WHERE a.id_user = @uid';

    try {
      const rows = await Pg.connectAndQuery(`
        SELECT a.id, a.nome_arquivo, a.titulo, a.subtitulo, a.modelo_ia,
               a.tokens_in, a.tokens_out, a.custo_estimado, a.criado_em,
               u.nome AS autor_nome
          FROM tab_apoio_apresentacao a
          LEFT JOIN tab_intranet_usr u ON u.id = a.id_user
          ${filtroUser}
         ORDER BY a.criado_em DESC
         LIMIT @lim OFFSET @off`,
        { uid: user.ID, lim: limit, off: offset }
      );

      const total = await Pg.connectAndQuery(
        `SELECT COUNT(*) total FROM tab_apoio_apresentacao a ${filtroUser}`,
        { uid: user.ID }
      );

      return res.json({ apresentacoes: rows, total: Number(total[0]?.total || 0) });
    } catch (err) {
      console.error('apoio/list:', err);
      return res.status(500).json({ message: 'Erro ao listar: ' + err.message });
    }
  }
});
