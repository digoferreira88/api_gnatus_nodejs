// GET /tecnologia/acesso-tags — lista as posições ocupadas do controle de acesso
// Intelbras (tab_acesso_tag). Perm 1034. A tela completa as 1000 posições vazias.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1034]);

module.exports = (app) => ({
  verb: 'get',
  route: '/acesso-tags',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    try {
      const rows = await Pg.connectAndQuery(`
        SELECT posicao, colaborador, setor, tag, obs, atualizado_por, atualizado_em
          FROM tab_acesso_tag ORDER BY posicao`, {});
      return res.json({
        total: rows.length,
        capacidade: 1000,
        geradoEm: new Date().toISOString(),
        posicoes: rows
      });
    } catch (err) {
      console.error('tecnologia/acesso-tags-list:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
