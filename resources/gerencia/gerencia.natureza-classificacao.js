// GET /gerencia/natureza-classificacao
//
// Devolve o mapping atual da tab_natureza_classificacao (12 linhas seed +
// o que o financeiro tiver adicionado). Usado pelo /gerencia/dashboard-receita
// pra agrupar Custo/Despesa, Variavel/Fixo, Operacional/Nao-operacional sem
// hardcode.
//
// Permissao 10001 (DRE Gerencial).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([10001]);

module.exports = (app) => ({
  verb: 'get',
  route: '/natureza-classificacao',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    try {
      const rows = await app.services.Pg.connectAndQuery(`
        SELECT id, natureza, descricao, tipo, classificacao, operacional, obs,
               atualizado_em
          FROM tab_natureza_classificacao
         ORDER BY natureza`);
      return res.json({ classificacoes: rows, total: rows.length });
    } catch (err) {
      console.error('natureza-classificacao:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
