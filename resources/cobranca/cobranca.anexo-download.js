// Download autenticado de anexo.
// GET /cobranca/anexo/:id/download[?token=...]
//
// Aceita token via querystring (igual aos outros endpoints de PDF/HTML),
// pra permitir abrir em nova aba sem JS.

const fs = require('fs');
const path = require('path');

const UPLOAD_ROOT = process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads');

module.exports = (app) => ({
  verb: 'get',
  route: '/anexo/:id/download',
  middlewares: [require('../../middlewares/requirePerm')(app)([9001, 9002])],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).send('ID invalido.');

    try {
      const r = await Pg.connectAndQuery(
        `SELECT arquivo_path, arquivo_nome_original, arquivo_mime
           FROM tab_cobranca_anexo WHERE id = @id`, { id }
      );
      if (!r.length) return res.status(404).send('Anexo nao encontrado.');

      const a = r[0];
      // Sanitiza path pra evitar traversal (../etc/passwd)
      const safeRel = String(a.arquivo_path).replace(/\\/g, '/');
      if (safeRel.includes('..') || path.isAbsolute(safeRel)) {
        return res.status(400).send('Path invalido.');
      }
      const fullPath = path.join(UPLOAD_ROOT, safeRel);

      if (!fs.existsSync(fullPath)) {
        return res.status(404).send('Arquivo fisico ausente.');
      }

      res.setHeader('Content-Type', a.arquivo_mime || 'application/octet-stream');
      // inline pra PDFs/imagens (browser exibe), attachment forcaria download
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(a.arquivo_nome_original)}"`);
      const stream = fs.createReadStream(fullPath);
      stream.on('error', err => {
        console.error('Erro stream anexo:', err.message);
        if (!res.headersSent) res.status(500).send('Erro ao ler arquivo.');
      });
      stream.pipe(res);
    } catch (err) {
      console.error('Erro cobranca/anexo download:', err);
      return res.status(500).send('Erro: ' + err.message);
    }
  }
});
