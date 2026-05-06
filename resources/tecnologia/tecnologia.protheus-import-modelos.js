// GET /tecnologia/protheus-import/modelos — lista os 47+ IDs disponiveis
// (catalogo estatico, do MIT072). Permissao 1031.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1031]);
const Trpwsimp = require('../../services/trpwsimp');

module.exports = (app) => ({
  verb: 'get',
  route: '/protheus-import/modelos',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    return res.json({ modelos: Trpwsimp.MODELOS, baseUrl: Trpwsimp.BASE_URL });
  }
});
