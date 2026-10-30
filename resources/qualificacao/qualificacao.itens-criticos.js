// GET /qualificacao/itens-criticos?q=&criticidade= — Lista de componentes e serviços críticos
// (PRO 7.3.7 item 5.2): item → criticidade A/B/C/D. É ela que define a criticidade do
// fornecedor ("o fornecedor é qualificado pela criticidade do item que fornece"). Perm 23001+.

const Q = require('../../services/qfCore');

module.exports = (app) => ({
  verb: 'get',
  route: '/itens-criticos',
  middlewares: [Q.mw(app, 'consulta')],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const cond = ['TRUE'], p = {};
    const q = Q.trim(req.query.q);
    if (q) { cond.push('(i.produto ILIKE @like OR i.descricao ILIKE @like OR i.produto_chave = @chave)'); p.like = `%${q}%`; p.chave = q.toUpperCase().replace(/^0+(?=.)/, ''); }
    if (/^[ABCD]$/.test(Q.trim(req.query.criticidade))) { cond.push('i.criticidade = @c'); p.c = Q.trim(req.query.criticidade); }
    if (Q.trim(req.query.ativos) !== 'todos') cond.push('i.ativo');
    try {
      const linhas = await Pg.connectAndQuery(
        `SELECT i.*, u.nome AS atualizado_por_nome FROM tab_qf_item_critico i LEFT JOIN tab_intranet_usr u ON u.id = i.atualizado_por
          WHERE ${cond.join(' AND ')} ORDER BY i.criticidade, i.produto LIMIT 2000`, p);
      const cont = await Pg.connectAndQuery(`SELECT criticidade, COUNT(*)::int n FROM tab_qf_item_critico WHERE ativo GROUP BY 1`);
      return res.json({ linhas, porCriticidade: Object.fromEntries(cont.map(c => [c.criticidade, c.n])) });
    } catch (err) { return Q.falha(res, 'listar os itens críticos', err); }
  }
});
