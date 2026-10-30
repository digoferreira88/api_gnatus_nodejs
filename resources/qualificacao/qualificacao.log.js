// GET /qualificacao/log?fornecedorId=&entidade=&entidadeId=&limite= — trilha de
// auditoria (tab_qf_log, somente inclusão). Perm 23001+.

const Q = require('../../services/qfCore');

module.exports = (app) => ({
  verb: 'get',
  route: '/log',
  middlewares: [Q.mw(app, 'consulta')],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const cond = [];
    const p = { lim: Math.min(1000, Math.max(1, Number(req.query.limite) || 300)) };
    if (req.query.fornecedorId) { cond.push('l.fornecedor_id = @f'); p.f = Number(req.query.fornecedorId); }
    if (req.query.entidade) { cond.push('l.entidade = @e'); p.e = Q.trim(req.query.entidade); }
    if (req.query.entidadeId) { cond.push('l.entidade_id = @eid'); p.eid = Number(req.query.entidadeId); }
    if (!cond.length) cond.push('TRUE');
    try {
      const linhas = await Pg.connectAndQuery(
        `SELECT l.id, l.entidade, l.entidade_id, l.fornecedor_id, l.acao, l.campo, l.valor_anterior, l.valor_novo, l.motivo,
                l.usuario_nome, l.ip, l.criado_em, f.codigo AS fornecedor_codigo
           FROM tab_qf_log l LEFT JOIN tab_qf_fornecedor f ON f.id = l.fornecedor_id
          WHERE ${cond.join(' AND ')}
          ORDER BY l.criado_em DESC, l.id DESC LIMIT @lim`, p);
      return res.json({ linhas });
    } catch (err) { return Q.falha(res, 'carregar a trilha de auditoria', err); }
  }
});
