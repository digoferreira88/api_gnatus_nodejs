// POST /tecnologia/protheus-import/layouts — cria novo layout (perm 1031).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1031]);
const trim = (v) => v == null ? null : String(v).trim() || null;

module.exports = (app) => ({
  verb: 'post',
  route: '/protheus-import/layouts',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const b = req.body || {};
    if (!trim(b.nome)) return res.status(400).json({ message: 'nome obrigatorio.' });
    if (!b.modelo_id) return res.status(400).json({ message: 'modelo_id obrigatorio.' });
    if (!trim(b.tabela)) return res.status(400).json({ message: 'tabela obrigatoria.' });
    if (!Array.isArray(b.campos) || !b.campos.length) return res.status(400).json({ message: 'campos[] obrigatorio.' });

    try {
      const r = await Pg.connectAndQuery(`
        INSERT INTO tab_protheus_import_layout
          (nome, modelo_id, modelo_nome, tabela, campos, notas, visibilidade, criado_por)
        VALUES
          (@nome, @mid, @mnome, @tab, @campos::jsonb, @notas, COALESCE(@vis, 'private'), @uid)
        RETURNING id`,
        {
          nome: trim(b.nome),
          mid: Number(b.modelo_id),
          mnome: trim(b.modelo_nome),
          tab: trim(b.tabela),
          campos: JSON.stringify(b.campos),
          notas: trim(b.notas),
          vis: ['private', 'public'].includes(b.visibilidade) ? b.visibilidade : 'private',
          uid: user.ID
        }
      );
      return res.json({ ok: true, id: r[0].id });
    } catch (err) {
      console.error('protheus-import-layout create:', err);
      return res.status(500).json({ message: 'Erro ao criar layout: ' + err.message });
    }
  }
});
