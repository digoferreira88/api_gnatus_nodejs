// DELETE /tecnologia/vendedor-avatar/:codigo
// Remove o avatar do vendedor. O ranking volta a mostrar iniciais coloridas.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1028]);
const trim = (v) => String(v || '').trim();

module.exports = (app) => ({
  verb: 'delete',
  route: '/vendedor-avatar/:codigo',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const codigo = trim(req.params.codigo);
    if (!codigo) return res.status(400).json({ message: 'codigo obrigatorio.' });

    try {
      const rows = await Pg.connectAndQuery(
        `DELETE FROM tab_vendedor_avatar WHERE codigo = @cod RETURNING codigo`,
        { cod: codigo });
      if (!rows.length) return res.status(404).json({ message: 'Avatar nao encontrado.' });
      return res.json({ ok: true, codigo: rows[0].codigo });
    } catch (err) {
      console.error('vendedor-avatar-remover:', err);
      return res.status(500).json({ message: 'Erro ao remover avatar: ' + err.message });
    }
  }
});
