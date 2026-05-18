// GET /permissoes/all — catalogo de permissoes. Perm 1026 (Gestao Permissoes).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1026, 1028]);

module.exports = (app) => ({
  verb: "get",
  route: "/all",
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const data = await Pg.connectAndQuery(`
      SELECT id, id_permissao, nome, modulo
        FROM tab_intranet_permissoes
       ORDER BY id_permissao
    `);
    return res.json(data);
  },
});
