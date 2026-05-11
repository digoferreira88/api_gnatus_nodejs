// GET /contratos/:id/anexos/:anexoId — download do anexo
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([5002]);

module.exports = (app) => ({
  verb: 'get',
  route: '/:id/anexos/:anexoId',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const id = Number(req.params.id);
    const anexoId = Number(req.params.anexoId);
    if (!Number.isInteger(id) || !Number.isInteger(anexoId)) return res.status(400).json({ message: 'ids invalidos.' });
    try {
      const r = await Pg.connectAndQuery(
        `SELECT nome_arquivo, mime_type, conteudo
           FROM tab_contrato_anexo
          WHERE id = @aid AND id_contrato = @cid`,
        { aid: anexoId, cid: id }
      );
      if (!r.length) return res.status(404).json({ message: 'Anexo nao encontrado.' });
      const a = r[0];
      const safeName = String(a.nome_arquivo).replace(/[^\x20-\x7E]/g, '_');
      res.setHeader('Content-Type', a.mime_type || 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(a.nome_arquivo)}`);
      res.setHeader('Cache-Control', 'private, max-age=300');
      return res.end(a.conteudo);
    } catch (err) {
      console.error('contratos/anexo-download:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
