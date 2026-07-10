// DELETE /gerencia/cc-depara/:id — remove um de-para fornecedor -> CC. Perm 10001.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([10001]);
const Auditoria = require('../../services/auditoria');

module.exports = (app) => ({
  verb: 'delete',
  route: '/cc-depara/:id',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'id inválido.' });
    try {
      const r = await Pg.connectAndQuery(
        `DELETE FROM tab_cc_fornecedor_depara WHERE id = @id RETURNING fornece, loja, cc`, { id });
      if (!r.length) return res.status(404).json({ message: 'De-para não encontrado.' });
      Auditoria.registrar(app, {
        modulo: 'Gerência', submodulo: 'DRE-CC', acao: 'DEPARA_CC_REMOVER', severidade: 'INFO', req,
        entidade: 'cc_fornecedor_depara', entidadeId: String(id),
        descricao: `Removeu de-para fornecedor ${r[0].fornece}${r[0].loja ? '/' + r[0].loja : ''} -> CC ${r[0].cc}`,
        meta: r[0]
      });
      return res.json({ ok: true });
    } catch (err) {
      console.error('gerencia/cc-depara remover:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
