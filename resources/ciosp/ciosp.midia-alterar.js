// PUT /ciosp/midia/:id — altera título e vínculo (código de foto ou seção de catálogo).
// Perm 19004.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([19004, 0]);
const Edicao = require('../../services/ciospEdicao');

module.exports = (app) => ({
  verb: 'put',
  route: '/midia/:id',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: 'Id inválido.' });
    const b = req.body || {};
    try {
      const [m] = await Edicao.q(app, `SELECT edicao, tipo FROM tab_ciosp_midia WHERE id = $1 AND ativo`, [id]);
      if (!m) return res.status(404).json({ message: 'Arquivo não encontrado.' });
      const titulo = String(b.titulo || '').trim().slice(0, 200) || null;
      const codigo = String(b.codigo || '').trim().slice(0, 60) || null;
      const secao = String(b.secao || '').trim().slice(0, 60) || null;
      if (m.tipo === 'catalogo' && !secao) return res.status(400).json({ message: 'Ligue o catálogo a uma seção.' });
      await Edicao.q(app, `UPDATE tab_ciosp_midia SET titulo = $1, codigo = $2, secao = $3 WHERE id = $4`,
        [titulo, m.tipo === 'foto' ? codigo : null, m.tipo === 'catalogo' ? secao : null, id]);
      await Edicao.tocarVersao(app, m.edicao);
      return res.json({ ok: true });
    } catch (err) {
      console.error('ciosp/midia (alterar):', err.message);
      return res.status(500).json({ message: 'Erro ao alterar: ' + err.message });
    }
  }
});
