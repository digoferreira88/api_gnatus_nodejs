// POST /integracao/shopify/rodar — dispara um ciclo do espelho Protheus -> Shopify
// agora, respeitando os tetos diário/ciclo.
//
// Com SHOPIFY_SIMULAR=1 o ciclo é dry-run: calcula o plano e NÃO chama a API — é o
// jeito de conferir o que aconteceria antes de ligar de verdade. Perm 22001 / 0.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([22001, 0]);
const ShopifyProdutos = require('../../services/shopifyProdutos');

module.exports = (app) => ({
  verb: 'post',
  route: '/shopify/rodar',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    if (!ShopifyProdutos.disponivel()) {
      return res.status(409).json({
        message: 'Espelho inativo — defina SHOPIFY_SHOP, SHOPIFY_TOKEN e SHOPIFY_ATIVO=1 no .env.'
      });
    }
    try {
      const r = await ShopifyProdutos.sincronizar({ Pg, Protheus }, 'MANUAL');
      return res.json({ ok: true, ...r });
    } catch (err) {
      console.error('Erro shopify/rodar:', err);
      return res.status(500).json({ message: 'Erro ao rodar o ciclo: ' + err.message });
    }
  }
});
