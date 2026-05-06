// GET /tecnologia/protheus-import/log — historico das execucoes (perm 1031).
// Query: ?limit=N (max 200, default 50)

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1031]);

module.exports = (app) => ({
  verb: 'get',
  route: '/protheus-import/log',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);
    try {
      const r = await Pg.connectAndQuery(`
        SELECT l.id, l.modelo_id, l.modelo_nome, l.tabela_destino,
               l.empresa, l.filial, l.protheus_user,
               l.sucesso, l.qt_total, l.qt_atualizados, l.qt_inconsistencias, l.duracao,
               l.erro, l.executado_em,
               u.email AS executado_por_email, u.nome AS executado_por_nome
          FROM tab_protheus_import_log l
          LEFT JOIN tab_intranet_usr u ON u.id = l.executado_por
         ORDER BY l.executado_em DESC
         LIMIT @lim`, { lim: limit });
      return res.json({ historico: r });
    } catch (err) {
      console.error('protheus-import-log:', err);
      return res.status(500).json({ message: 'Erro ao listar historico.' });
    }
  }
});
