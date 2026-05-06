// GET /tecnologia/auditoria/facets — listas distintas pra alimentar dropdowns
// (modulos, acoes, severidades + top usuarios). Perm 1032.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1032]);

module.exports = (app) => ({
  verb: 'get',
  route: '/auditoria/facets',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    try {
      const [modulos, acoes, severidades, usuarios] = await Promise.all([
        Pg.connectAndQuery(`SELECT modulo, COUNT(*) qt FROM tab_auditoria GROUP BY modulo ORDER BY qt DESC`, {}),
        Pg.connectAndQuery(`SELECT acao, COUNT(*) qt FROM tab_auditoria GROUP BY acao ORDER BY qt DESC LIMIT 30`, {}),
        Pg.connectAndQuery(`SELECT severidade, COUNT(*) qt FROM tab_auditoria GROUP BY severidade ORDER BY
                            CASE severidade WHEN 'CRITICO' THEN 1 WHEN 'ALERTA' THEN 2 WHEN 'AVISO' THEN 3 ELSE 4 END`, {}),
        Pg.connectAndQuery(`
          SELECT a.id_usuario, COALESCE(u.nome, a.usuario_nome) AS nome, COALESCE(u.email, a.usuario_email) AS email,
                 COUNT(*) qt
            FROM tab_auditoria a
            LEFT JOIN tab_intranet_usr u ON u.id = a.id_usuario
           WHERE a.id_usuario IS NOT NULL
           GROUP BY a.id_usuario, u.nome, a.usuario_nome, u.email, a.usuario_email
           ORDER BY qt DESC LIMIT 50`, {})
      ]);
      return res.json({ modulos, acoes, severidades, usuarios });
    } catch (err) {
      console.error('auditoria facets:', err);
      return res.status(500).json({ message: 'Erro ao listar facets.' });
    }
  }
});
