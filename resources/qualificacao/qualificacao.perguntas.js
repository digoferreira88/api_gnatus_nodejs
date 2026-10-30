// GET /qualificacao/perguntas — perguntas do questionário (FORM 7.3.21), inclusive
// inativas, com a contagem de uso. Perm 23001+.

const Q = require('../../services/qfCore');

module.exports = (app) => ({
  verb: 'get',
  route: '/perguntas',
  middlewares: [Q.mw(app, 'consulta')],

  handler: async (req, res) => {
    const { Pg } = app.services;
    try {
      const linhas = await Pg.connectAndQuery(
        `SELECT p.*, (SELECT COUNT(*)::int FROM tab_qf_resposta r WHERE r.pergunta_id = p.id) AS usos
           FROM tab_qf_pergunta p ORDER BY p.ordem, p.codigo`);
      return res.json({ linhas });
    } catch (err) { return Q.falha(res, 'listar as perguntas', err); }
  }
});
