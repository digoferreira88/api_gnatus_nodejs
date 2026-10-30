// GET /qualificacao/anexos/:anexoId — baixa/abre um anexo do módulo. Perm 23001+.

const Q = require('../../services/qfCore');

module.exports = (app) => ({
  verb: 'get',
  route: '/anexos/:anexoId',
  middlewares: [Q.mw(app, 'consulta')],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const id = Number(req.params.anexoId);
    if (!Number.isInteger(id)) return res.status(400).json({ message: 'id inválido.' });
    try {
      const [a] = await Pg.connectAndQuery(`SELECT nome_arquivo, mime_type, conteudo, excluido FROM tab_qf_anexo WHERE id = @id`, { id });
      if (!a || a.excluido) return res.status(404).json({ message: 'Anexo não encontrado.' });
      const seguro = String(a.nome_arquivo).replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
      res.setHeader('Content-Type', a.mime_type || 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename="${seguro}"; filename*=UTF-8''${encodeURIComponent(a.nome_arquivo)}`);
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return res.end(a.conteudo);
    } catch (err) { return Q.falha(res, 'baixar o anexo', err); }
  }
});
