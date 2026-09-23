// GET /compras/cockpit-sop — objeto D do Cockpit S&OP (Demand Planning).
//
// Substitui os 4 uploads do painel (vendas, faturamento, carteira, estoque): tudo sai
// do Protheus. Regras e fórmulas em services/cockpitSop.js e cockpitSopMontar.js;
// contrato em docs/compras/gnatus_cockpit_sop_CONTEXTO.md.
//
// ?recarregar=1 ignora o cache (padrão 15 min, COCKPIT_SOP_TTL_MIN).
// Permissão 4008.

const Cockpit = require('../../services/cockpitSopMontar');
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([4008]);

module.exports = (app) => ({
  verb: 'get',
  route: '/cockpit-sop',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    try {
      const semCache = /^(1|true|sim)$/i.test(String(req.query.recarregar || ''));
      return res.json(await Cockpit.obterD(app, { semCache }));
    } catch (err) {
      console.error('Erro compras/cockpit-sop:', err);
      return res.status(500).json({ message: 'Não foi possível montar o cockpit. Tente de novo em instantes.' });
    }
  }
});
