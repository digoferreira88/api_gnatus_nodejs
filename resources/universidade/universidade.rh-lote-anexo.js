// GET /universidade/rh/lote/:id/anexo — abre o anexo (lista de presença) de um lançamento.
// Perm 15004/15005/15003.

const fs = require('fs');
const path = require('path');
const { LER, UPLOAD_ROOT, requirePerm } = require('./_rh');

module.exports = (app) => ({
  verb: 'get',
  route: '/rh/lote/:id/anexo',
  middlewares: [requirePerm(app, LER)],

  handler: async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).send('ID inválido.');
    const r = await app.services.Pg.connectAndQuery(
      `SELECT anexo_path, anexo_nome, anexo_mime FROM tab_uni_registro_lote WHERE id = @id`, { id });
    if (!r.length || !r[0].anexo_path) return res.status(404).send('Anexo não encontrado.');
    const rel = String(r[0].anexo_path).replace(/\\/g, '/');
    if (rel.includes('..') || path.isAbsolute(rel)) return res.status(400).send('Caminho inválido.');
    const full = path.join(UPLOAD_ROOT, rel);
    if (!fs.existsSync(full)) return res.status(404).send('Arquivo físico ausente.');
    res.setHeader('Content-Type', r[0].anexo_mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(r[0].anexo_nome || 'anexo')}"`);
    fs.createReadStream(full).on('error', () => { if (!res.headersSent) res.status(500).send('Erro ao ler arquivo.'); }).pipe(res);
  }
});
