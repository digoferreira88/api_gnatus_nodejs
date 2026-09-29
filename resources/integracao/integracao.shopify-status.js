// GET /integracao/shopify/status — panorama do espelho Protheus -> Shopify:
// configurado?, ligado?, em simulação?, seed feito?, quantos sincronizados/faltando/
// órfãos, uso do dia vs teto, estado do cadastro ACU/ACV no Protheus e últimos ciclos.
// Perm 22001 / 0 (admin).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([22001, 0]);
const ShopifyProdutos = require('../../services/shopifyProdutos');

module.exports = (app) => ({
  verb: 'get',
  route: '/shopify/status',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    try {
      const panorama = await ShopifyProdutos.panorama({ Pg, Protheus });
      const logs = await ShopifyProdutos.ultimosLogs(Pg, 15);
      return res.json({ ...panorama, logs });
    } catch (err) {
      console.error('Erro shopify/status:', err);
      return res.status(500).json({ message: 'Erro ao ler status: ' + err.message });
    }
  }
});
