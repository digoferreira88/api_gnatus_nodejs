// GET /planejamento/controle/usuarios — lista de usuários atribuíveis como
// responsável (picker). Permissão 3003.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([3003]);
const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'get',
  route: '/controle/usuarios',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    try {
      const rows = await Pg.connectAndQuery(
        `SELECT id, nome FROM tab_intranet_usr WHERE nome IS NOT NULL AND TRIM(nome) <> '' ORDER BY nome`, {});
      return res.json({ usuarios: rows.map(r => ({ id: r.id, nome: trim(r.nome) })) });
    } catch (err) {
      console.error('Erro controle-usuarios:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
