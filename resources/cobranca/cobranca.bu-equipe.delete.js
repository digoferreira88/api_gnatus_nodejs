// Remove um mapeamento BU -> Equipe.
// Body: { buCodigo }

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([9001, 9002]);

module.exports = (app) => ({
  verb: 'delete',
  route: '/bu-equipe',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Usuário não autenticado.' });

    const buCodigo = String((req.body && req.body.buCodigo) || req.query.buCodigo || '').trim();
    if (!buCodigo) return res.status(400).json({ message: 'buCodigo é obrigatório.' });

    try {
      const r = await Pg.connectAndQuery(
        `DELETE FROM tab_cobranca_bu_equipe WHERE bu_codigo = @cod RETURNING bu_codigo`,
        { cod: buCodigo }
      );
      if (r.length === 0) return res.status(404).json({ message: 'Mapeamento não encontrado.' });
      return res.json({ ok: true });
    } catch (err) {
      console.error('Erro cobranca/bu-equipe:delete:', err);
      return res.status(500).json({ message: 'Erro ao remover mapeamento.' });
    }
  }
});
