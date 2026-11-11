// GET /ciosp/precos/modelo — planilha modelo da Tabela Comercial para o comercial
// preencher. Perm 19004.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([19004, 0]);
const Tabela = require('../../services/ciospTabela');

module.exports = (app) => ({
  verb: 'get',
  route: '/precos/modelo',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    try {
      const buf = await Tabela.gerarModelo();
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="modelo-tabela-ciosp.xlsx"');
      return res.send(buf);
    } catch (err) {
      console.error('ciosp/precos/modelo:', err.message);
      return res.status(500).json({ message: 'Erro ao gerar o modelo: ' + err.message });
    }
  }
});
