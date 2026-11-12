// GET /ciosp/usuarios?busca= — busca usuários ativos da intranet para montar a equipe
// do evento (só id, nome e e-mail). Perm 19004 — a lista completa de usuários
// (/users/all) exige a perm de administração de usuários.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([19004, 0]);

module.exports = (app) => ({
  verb: 'get',
  route: '/usuarios',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const busca = String(req.query.busca || '').trim();
    if (busca.length < 2) return res.status(400).json({ message: 'Digite ao menos 2 caracteres.' });
    try {
      const rows = await app.services.Pg.connectAndQuery(
        `SELECT id, nome, email FROM tab_intranet_usr
          WHERE ativo AND (nome ILIKE @q OR email ILIKE @q)
          ORDER BY nome LIMIT 20`, { q: `%${busca}%` });
      return res.json(rows.map(u => ({ id: u.id, nome: u.nome, email: u.email })));
    } catch (err) {
      console.error('ciosp/usuarios:', err.message);
      return res.status(500).json({ message: 'Erro ao buscar usuários: ' + err.message });
    }
  }
});
