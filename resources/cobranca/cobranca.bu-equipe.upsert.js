// Cria ou atualiza um mapeamento BU -> Equipe.
// Body: { buCodigo, equipe }

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([9001, 9002]);

module.exports = (app) => ({
  verb: 'post',
  route: '/bu-equipe',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Usuário não autenticado.' });

    const buCodigo = String((req.body && req.body.buCodigo) || '').trim();
    const equipe   = String((req.body && req.body.equipe)   || '').trim();
    if (!buCodigo) return res.status(400).json({ message: 'buCodigo é obrigatório.' });
    if (!equipe)   return res.status(400).json({ message: 'equipe é obrigatória.' });

    try {
      const r = await Pg.connectAndQuery(
        `INSERT INTO tab_cobranca_bu_equipe (bu_codigo, equipe, atualizado_por, atualizado_em)
         VALUES (@cod, @equipe, @uid, NOW())
         ON CONFLICT (bu_codigo) DO UPDATE SET
           equipe = EXCLUDED.equipe,
           atualizado_por = EXCLUDED.atualizado_por,
           atualizado_em  = NOW()
         RETURNING bu_codigo, equipe, atualizado_em`,
        { cod: buCodigo, equipe, uid: user.ID }
      );
      return res.json({ ok: true, mapeamento: r[0] });
    } catch (err) {
      console.error('Erro cobranca/bu-equipe:upsert:', err);
      return res.status(500).json({ message: 'Erro ao gravar mapeamento.' });
    }
  }
});
