// GET /gerencia/cc-usuario/:idUser — centros de custo do DRE restrito (perm 10003)
// vinculados a um usuário. Administrado pela Gestão de Usuários (perm 1028).
// Migration 88 (tab_dre_cc_usuario).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1028]);
const trim = (v) => String(v || '').trim();

module.exports = (app) => ({
  verb: 'get',
  route: '/cc-usuario/:idUser',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const idUser = Number(req.params.idUser);
    if (!idUser) return res.status(400).json({ message: 'idUser inválido.' });
    try {
      const rows = await Pg.connectAndQuery(
        `SELECT cc_codigo, cc_descricao FROM tab_dre_cc_usuario
          WHERE id_user = @id ORDER BY cc_codigo`, { id: idUser });
      return res.json({ ccs: rows.map(r => ({ codigo: trim(r.cc_codigo), descricao: trim(r.cc_descricao) })) });
    } catch (err) {
      console.error('gerencia/cc-usuario GET:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
