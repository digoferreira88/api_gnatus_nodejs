// POST /qualificacao/inspecoes — lança um relatório de inspeção de recebimento.
// Calcula C, P, N e IQF, recalcula a média do fornecedor e aplica as ações de classe.
// Regras de permissão em services/qfInspecao.js. Perm 23002+ (Inspetor).

const Q = require('../../services/qfCore');
const I = require('../../services/qfInspecao');

module.exports = (app) => ({
  verb: 'post',
  route: '/inspecoes',
  middlewares: [Q.mw(app, 'inspetor')],

  handler: async (req, res) => {
    try {
      const r = await I.salvar(app, req, req.body || {});
      return res.json({ ok: true, ...r });
    } catch (err) {
      if (err instanceof I.ErroHttp) return res.status(err.status).json({ message: err.message, ...(err.extra || {}) });
      return Q.falha(res, 'salvar a inspeção', err);
    }
  }
});
