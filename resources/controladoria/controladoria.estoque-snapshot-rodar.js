// POST /controladoria/estoque-snapshot-rodar?meses=12
// Dispara o snapshot de estoque manualmente. Usado pra bootstrap inicial
// (preencher 12 meses de uma vez) ou pra forcar re-calculo apos correcao.
// Permissao 11004.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([11004]);
const EstoqueSnapshot = require('../../services/estoqueSnapshot');

module.exports = (app) => ({
  verb: 'post',
  route: '/estoque-snapshot-rodar',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const meses = Math.min(Math.max(Number(req.query.meses) || 1, 1), 24);

    try {
      // Roda em background mas espera o primeiro resultado pra responder rapido
      // ao usuario. Pra meses=1 demora ~5s, pra meses=12 pode levar 60-90s.
      const stats = await EstoqueSnapshot.atualizar(app, { meses });
      return res.json({ ok: true, ...stats });
    } catch (err) {
      console.error('estoque-snapshot-rodar:', err);
      return res.status(500).json({ message: 'Erro ao rodar snapshot: ' + err.message });
    }
  }
});
