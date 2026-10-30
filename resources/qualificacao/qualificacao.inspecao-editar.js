// PUT /qualificacao/inspecoes/:id — altera um relatório (motivo obrigatório; o
// inspetor só altera os próprios). Perm 23002+.

const Q = require('../../services/qfCore');
const I = require('../../services/qfInspecao');

module.exports = (app) => ({
  verb: 'put',
  route: '/inspecoes/:id',
  middlewares: [Q.mw(app, 'inspetor')],

  handler: async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: 'id inválido.' });
    try {
      const r = await I.salvar(app, req, req.body || {}, id);
      return res.json({ ok: true, ...r });
    } catch (err) {
      if (err instanceof I.ErroHttp) return res.status(err.status).json({ message: err.message, ...(err.extra || {}) });
      return Q.falha(res, 'alterar a inspeção', err);
    }
  }
});
