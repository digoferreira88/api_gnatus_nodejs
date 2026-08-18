// GET /tecnologia/acesso-tags — dispositivos (controladores Intelbras) + posições
// ocupadas de cada um. Perm 1034. A tela monta uma aba por dispositivo.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1034]);

module.exports = (app) => ({
  verb: 'get',
  route: '/acesso-tags',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    try {
      const dispositivos = await Pg.connectAndQuery(`
        SELECT d.id, d.nome, d.local, d.capacidade, d.ordem,
               COUNT(t.posicao)::int ocupadas
          FROM tab_acesso_dispositivo d
          LEFT JOIN tab_acesso_tag t ON t.dispositivo_id = d.id
         GROUP BY d.id ORDER BY d.ordem, d.id`, {});
      const posicoes = await Pg.connectAndQuery(`
        SELECT dispositivo_id, posicao, colaborador, setor, tag, obs, atualizado_por, atualizado_em
          FROM tab_acesso_tag ORDER BY dispositivo_id, posicao`, {});
      return res.json({
        geradoEm: new Date().toISOString(),
        dispositivos,
        posicoes
      });
    } catch (err) {
      console.error('tecnologia/acesso-tags-list:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
