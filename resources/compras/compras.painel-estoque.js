// GET /compras/painel-estoque — objeto DATA do Painel de Estoque (Compras).
//
// Substitui os 3 uploads diários que o painel pedia (posição de estoque, pedidos de
// compra e carteira): tudo sai do Protheus. Regras em services/painelEstoqueCompras.js;
// contrato em docs/compras/Painel_Estoque_GNATUS_Contexto.md.
//
// ?recarregar=1 ignora o cache (padrão: 10 min, PAINEL_ESTOQUE_TTL_MIN).
// Permissão 4007.

const Painel = require('../../services/painelEstoqueCompras');
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([4007]);

module.exports = (app) => ({
  verb: 'get',
  route: '/painel-estoque',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    try {
      const semCache = /^(1|true|sim)$/i.test(String(req.query.recarregar || ''));
      const dados = await Painel.montarDados(app, { semCache });
      return res.json(dados);
    } catch (err) {
      console.error('Erro compras/painel-estoque:', err);
      return res.status(500).json({ message: 'Não foi possível montar o painel de estoque. Tente de novo em instantes.' });
    }
  }
});
