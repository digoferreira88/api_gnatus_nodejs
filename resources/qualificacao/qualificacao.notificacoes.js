// GET /qualificacao/notificacoes?limite= — o que o módulo tentou avisar: enviados e os
// que ficaram retidos (sem destinatário configurado, envio ao fornecedor desligado,
// erro). Perm 23004+ (Qualidade).

const Q = require('../../services/qfCore');

module.exports = (app) => ({
  verb: 'get',
  route: '/notificacoes',
  middlewares: [Q.mw(app, 'qualidade')],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const lim = Math.min(500, Math.max(1, Number(req.query.limite) || 100));
    try {
      const linhas = await Pg.connectAndQuery(
        `SELECT n.id, n.tipo, n.entidade, n.entidade_id, n.fornecedor_id, f.codigo, f.razao_social, n.destinatarios, n.assunto, n.enviado, n.erro, n.criado_em
           FROM tab_qf_notificacao n LEFT JOIN tab_qf_fornecedor f ON f.id = n.fornecedor_id
          ORDER BY n.criado_em DESC LIMIT @lim`, { lim });
      return res.json({ linhas });
    } catch (err) { return Q.falha(res, 'listar as notificações', err); }
  }
});
