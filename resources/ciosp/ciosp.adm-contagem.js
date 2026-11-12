// GET /ciosp/adm/contagem — número da barra lateral da Fila do ADM. Perm 19004.
// aguardando = pedidos enviados que ninguém assumiu; meus = os que estão comigo e
// ainda não terminaram (em análise ou conferidos).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([19004, 0]);
const E = require('../../services/ciospEdicao');

module.exports = (app) => ({
  verb: 'get',
  route: '/adm/contagem',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const user = req.user && req.user[0];
    const uid = Number(user?.ID ?? user?.id) || 0;
    try {
      const { edicao } = await E.getConfig(app);
      if (!edicao) return res.json({ edicao: null, aguardando: 0, meus: 0 });
      const r = await app.services.Pg.connectAndQuery(
        `SELECT COUNT(*) FILTER (WHERE situacao = 'enviado')::int AS aguardando,
                COUNT(*) FILTER (WHERE situacao IN ('em_analise', 'conferido') AND adm_responsavel = @eu)::int AS meus
           FROM tab_ciosp_pedido WHERE edicao = @edicao`, { edicao, eu: uid });
      return res.json({ edicao, aguardando: r[0].aguardando, meus: r[0].meus });
    } catch (err) {
      console.error('ciosp/adm-contagem:', err.message);
      return res.status(500).json({ message: 'Erro ao contar a fila: ' + err.message });
    }
  }
});
