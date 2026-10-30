// GET /qualificacao/regras — todas as versões de regra (faixas de C, P, N, classes,
// questionário, amostragem), a ativa primeiro. Leitura aberta a todo o módulo: a
// regra é documento controlado e qualquer um pode conferir com qual foi calculado.
// Perm 23001+.

const Q = require('../../services/qfCore');

module.exports = (app) => ({
  verb: 'get',
  route: '/regras',
  middlewares: [Q.mw(app, 'consulta')],

  handler: async (req, res) => {
    const { Pg } = app.services;
    try {
      const linhas = await Pg.connectAndQuery(
        `SELECT r.*, uc.nome AS criado_por_nome, ua.nome AS ativada_por_nome,
                (SELECT COUNT(*)::int FROM tab_qf_inspecao i WHERE i.regra_versao_id = r.id AND NOT i.excluido) AS inspecoes
           FROM tab_qf_regra_versao r
           LEFT JOIN tab_intranet_usr uc ON uc.id = r.criado_por
           LEFT JOIN tab_intranet_usr ua ON ua.id = r.ativada_por
          ORDER BY r.ativa DESC, r.id DESC`);
      return res.json({ linhas });
    } catch (err) { return Q.falha(res, 'listar as regras', err); }
  }
});
