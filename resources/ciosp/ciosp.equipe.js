// GET /ciosp/equipe?edicao= — equipe do evento (vendedores e gerentes). Perm 19004/19001.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([19004, 19001, 0]);

module.exports = (app) => ({
  verb: 'get',
  route: '/equipe',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const edicao = String(req.query.edicao || '').trim();
    if (!edicao) return res.status(400).json({ message: 'Informe a edição.' });
    try {
      const rows = await app.services.Pg.connectAndQuery(
        `SELECT e.id, e.usuario_id, e.nome_exibicao, e.papel, e.gerente_id, e.categoria, e.equipe, e.ativo,
                u.email, u.nome usuario_nome, g.nome_exibicao gerente_nome
           FROM tab_ciosp_equipe e
           LEFT JOIN tab_intranet_usr u ON u.id = e.usuario_id
           LEFT JOIN tab_ciosp_equipe g ON g.edicao = e.edicao AND g.usuario_id = e.gerente_id
          WHERE e.edicao = @edicao
          ORDER BY e.papel DESC, e.categoria NULLS FIRST, e.nome_exibicao`, { edicao });
      return res.json(rows.map(r => ({
        id: r.id, usuario_id: r.usuario_id, nome_exibicao: r.nome_exibicao, papel: r.papel,
        gerente_id: r.gerente_id, gerente_nome: r.gerente_nome, categoria: r.categoria, equipe: r.equipe,
        ativo: !!r.ativo, email: r.email, usuario_nome: r.usuario_nome
      })));
    } catch (err) {
      console.error('ciosp/equipe:', err.message);
      return res.status(500).json({ message: 'Erro ao listar a equipe: ' + err.message });
    }
  }
});
