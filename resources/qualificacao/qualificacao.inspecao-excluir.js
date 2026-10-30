// POST /qualificacao/inspecoes/:id/excluir — exclusão LÓGICA (o registro continua no
// banco, fora do IQF), com motivo. Perm 23004+ (Qualidade).

const Q = require('../../services/qfCore');
const I = require('../../services/qfInspecao');

module.exports = (app) => ({
  verb: 'post',
  route: '/inspecoes/:id/excluir',
  middlewares: [Q.mw(app, 'qualidade')],

  handler: async (req, res) => {
    const id = Number(req.params.id);
    try {
      const r = await I.excluir(app, req, id, (req.body || {}).motivo);
      return res.json(r);
    } catch (err) {
      if (err instanceof I.ErroHttp) return res.status(err.status).json({ message: err.message });
      return Q.falha(res, 'excluir a inspeção', err);
    }
  }
});
