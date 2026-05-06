// CRUD de layouts salvos pra Importacao Protheus (perm 1031).
// Rotas:
//   GET    /protheus-import/layouts          — lista (do user OU publicos)
//   POST   /protheus-import/layouts          — cria
//   PUT    /protheus-import/layouts/:id      — edita (so dono)
//   DELETE /protheus-import/layouts/:id      — remove (so dono OU admin)
//
// Como o auto-loader usa 1 verb por arquivo, esse arquivo registra a LIST/CREATE.
// Os outros 2 (update/delete) ficam em arquivos separados.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1031]);

module.exports = (app) => ({
  verb: 'get',
  route: '/protheus-import/layouts',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    try {
      const r = await Pg.connectAndQuery(`
        SELECT l.id, l.nome, l.modelo_id, l.modelo_nome, l.tabela, l.campos, l.notas,
               l.visibilidade, l.criado_por, l.criado_em, l.atualizado_em,
               u.nome AS criado_por_nome, u.email AS criado_por_email,
               (l.criado_por = @uid) AS sou_dono
          FROM tab_protheus_import_layout l
          LEFT JOIN tab_intranet_usr u ON u.id = l.criado_por
         WHERE l.criado_por = @uid OR l.visibilidade = 'public'
         ORDER BY l.atualizado_em DESC
         LIMIT 200`,
        { uid: user.ID }
      );
      return res.json({ layouts: r });
    } catch (err) {
      console.error('protheus-import-layouts list:', err);
      return res.status(500).json({ message: 'Erro ao listar layouts.' });
    }
  }
});
