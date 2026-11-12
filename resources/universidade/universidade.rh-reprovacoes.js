// GET /universidade/rh/reprovacoes?de=&ate= — indicador de reprovações: por colaborador,
// por treinamento (com a taxa sobre o total de avaliações) e a lista das reprovações.
// Reprovação = prova finalizada sem aprovação OU lançamento com resultado "reprovado".
// Perm 15004/15005/15003.

const { LER, requirePerm, dataISO, indicadorReprovacoes } = require('./_rh');

module.exports = (app) => ({
  verb: 'get',
  route: '/rh/reprovacoes',
  middlewares: [requirePerm(app, LER)],

  handler: async (req, res) => {
    const dados = await indicadorReprovacoes(app.services.Pg, {
      de: dataISO(req.query.de), ate: dataISO(req.query.ate)
    });
    return res.json(dados);
  }
});
