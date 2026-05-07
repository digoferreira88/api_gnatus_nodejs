// GET /telefonia/dominios — operadoras + departamentos + contas (pra dropdowns
// do formulario). Permissao 1027.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1027]);

module.exports = (app) => ({
  verb: 'get',
  route: '/dominios',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    try {
      const operadoras    = await Pg.connectAndQuery(
        `SELECT id, nome FROM tab_operadora WHERE ativo = true ORDER BY nome`, {}
      );
      const departamentos = await Pg.connectAndQuery(
        `SELECT id, nome FROM tab_telefonia_departamento WHERE ativo = true ORDER BY nome`, {}
      );
      const contas        = await Pg.connectAndQuery(`
        SELECT c.id, c.numero_conta, c.numero_cliente, c.razao_social,
               o.nome AS operadora, c.id_operadora
          FROM tab_telefonia_conta c
          JOIN tab_operadora o ON o.id = c.id_operadora
         ORDER BY o.nome, c.numero_conta`, {});
      return res.json({ operadoras, departamentos, contas });
    } catch (err) {
      console.error('telefonia/dominios:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
