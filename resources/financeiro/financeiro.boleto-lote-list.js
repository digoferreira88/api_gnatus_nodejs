// GET /financeiro/boleto-lote — historico de lotes.
// Admin (perm 0) ve todos, demais veem so os proprios.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([8005]);

module.exports = (app) => ({
  verb: 'get',
  route: '/boleto-lote',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const limit  = Math.min(Math.max(Number(req.query.limit  || 100), 1), 500);
    const offset = Math.max(Number(req.query.offset || 0), 0);

    const isAdmin = await Pg.connectAndQuery(
      `SELECT 1 FROM tab_intranet_usr_permissoes WHERE id_user = @uid AND id_permissao = 0 LIMIT 1`,
      { uid: user.ID }
    );
    const where = isAdmin.length ? '' : 'WHERE l.id_user = @uid';
    const params = { uid: user.ID, lim: limit, off: offset };

    try {
      const lotes = await Pg.connectAndQuery(`
        SELECT l.id, l.banco_cod, l.banco_nome, l.qt_titulos, l.valor_total,
               l.status, l.observacao, l.criado_em, l.atualizado_em,
               l.usuario_nome
          FROM tab_boleto_envio_lote l
          ${where}
         ORDER BY l.criado_em DESC
         LIMIT @lim OFFSET @off`, params);

      const total = await Pg.connectAndQuery(
        `SELECT COUNT(*) total FROM tab_boleto_envio_lote l ${where}`, params
      );

      return res.json({ lotes, total: Number(total[0]?.total || 0) });
    } catch (err) {
      console.error('boleto-lote-list:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
