// GET /producao/usuarios-equipe — lista usuarios elegiveis pra serem
// responsaveis de etapa do registro de producao. Filtro: usuarios ATIVOS
// que tenham qualquer permissao do modulo Producao (14001 operar,
// 14002 admin, 14003 dashboard) OU 0 (admin global).
//
// Resposta: array compacto pra popular dropdown:
//   [{ id, nome, email, cargo? }]
//
// Permissao: 14001/14002/14003 (qualquer um do modulo).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([14001, 14002, 14003]);

module.exports = (app) => ({
  verb: 'get',
  route: '/usuarios-equipe',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    try {
      const rows = await Pg.connectAndQuery(`
        SELECT DISTINCT u.id, u.nome, u.email
          FROM tab_intranet_usr u
          JOIN tab_intranet_usr_permissoes p ON p.id_user = u.id
         WHERE u.ativo = true
           AND p.id_permissao IN (0, 14001, 14002, 14003)
         ORDER BY u.nome`,
        {}
      );
      return res.json(rows);
    } catch (err) {
      console.error('producao/usuarios-equipe:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
