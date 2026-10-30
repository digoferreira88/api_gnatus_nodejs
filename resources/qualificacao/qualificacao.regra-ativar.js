// POST /qualificacao/regras/:id/ativar — troca a versão de regra vigente (com motivo)
// e recalcula a classe dos fornecedores. Perm 23006 (Administração).

const Q = require('../../services/qfCore');
const ativarRegra = require('./_ativarRegra');

module.exports = (app) => ({
  verb: 'post',
  route: '/regras/:id/ativar',
  middlewares: [Q.mw(app, 'admin')],

  handler: async (req, res) => {
    const id = Number(req.params.id);
    const motivo = Q.nul((req.body || {}).motivo);
    if (!motivo) return res.status(400).json({ message: 'Informe o motivo (ex.: decisão da Qualidade sobre a tabela de prazo).' });
    try {
      const r = await ativarRegra(app, req, id, motivo);
      return res.json({ ok: true, ...r });
    } catch (err) {
      if (err.status === 404) return res.status(404).json({ message: err.message });
      return Q.falha(res, 'ativar a versão de regra', err);
    }
  }
});
