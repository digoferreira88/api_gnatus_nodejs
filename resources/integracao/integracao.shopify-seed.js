// POST /integracao/shopify/seed — registra em Postgres os produtos que JÁ existem na
// loja, casando pelo SKU da variante.
//
// Passo obrigatório antes do primeiro ciclo: sem ele o espelho não sabe o que já está
// lá e recriaria tudo como duplicata. SKU que está na loja e não no catálogo da ACV
// fica marcado 'orfao' e é deixado em paz (o espelho é aditivo, nunca apaga).
//
// Pode rodar de novo com segurança (idempotente por SKU). Perm 22001 / 0 (admin).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([22001, 0]);
const ShopifyProdutos = require('../../services/shopifyProdutos');
const ShopifyApi = require('../../services/shopifyApi');

module.exports = (app) => ({
  verb: 'post',
  route: '/shopify/seed',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    if (!ShopifyApi.configurado()) {
      return res.status(409).json({ message: 'Shopify não configurado — defina SHOPIFY_SHOP e SHOPIFY_TOKEN no .env.' });
    }
    try {
      const r = await ShopifyProdutos.seed({ Pg, Protheus });
      return res.json({ ok: true, ...r });
    } catch (err) {
      console.error('Erro shopify/seed:', err);
      return res.status(500).json({ message: 'Erro ao rodar o seed: ' + err.message });
    }
  }
});
