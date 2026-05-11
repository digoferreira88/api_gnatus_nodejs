// GET /contratos/dominios — lookups pro formulario (tipos, indices, usuarios)
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([5002]);
const Contratos = require('../../services/contratos');

module.exports = (app) => ({
  verb: 'get',
  route: '/dominios',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    try {
      const usuarios = await Pg.connectAndQuery(
        `SELECT id, nome, email FROM tab_intranet_usr WHERE ativo = true ORDER BY nome`, {}
      );
      return res.json({
        tipos: Contratos.TIPOS_VALIDOS.map(t => ({ cod: t, nome: Contratos.TIPOS_LABEL[t] })),
        contraparte_tipos: Contratos.CONTRAPARTE_TIPOS,
        indices: Contratos.INDICES,
        usuarios
      });
    } catch (err) {
      console.error('contratos/dominios:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
