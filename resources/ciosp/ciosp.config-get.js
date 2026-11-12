// GET /ciosp/config?edicao= — configuração da edição (sem edição: a ativa) e a lista
// de edições conhecidas, para o seletor da tela de gestão. Perm 19004/19001.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([19004, 19001, 0]);
const Edicao = require('../../services/ciospEdicao');

module.exports = (app) => ({
  verb: 'get',
  route: '/config',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    try {
      const edicao = String(req.query.edicao || '').trim() || null;
      const [config, edicoes] = await Promise.all([
        Edicao.getConfig(app, edicao),
        Pg.connectAndQuery(
          `SELECT edicao FROM tab_ciosp_meta
           UNION SELECT DISTINCT edicao FROM tab_ciosp_venda
           UNION SELECT DISTINCT edicao FROM tab_ciosp_preco
           ORDER BY 1 DESC`)
      ]);
      return res.json({ ...config, edicoes: edicoes.map(e => e.edicao) });
    } catch (err) {
      console.error('ciosp/config:', err.message);
      return res.status(500).json({ message: 'Erro ao ler a configuração: ' + err.message });
    }
  }
});
