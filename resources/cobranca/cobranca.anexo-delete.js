// Remove anexo (PG + arquivo fisico). DELETE /cobranca/anexo/:id

const fs = require('fs');
const path = require('path');

const UPLOAD_ROOT = process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads');

module.exports = (app) => ({
  verb: 'delete',
  route: '/anexo/:id',
  middlewares: [require('../../middlewares/requirePerm')(app)([9001, 9002])],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'ID invalido.' });

    try {
      const r = await Pg.connectAndQuery(
        `SELECT arquivo_path FROM tab_cobranca_anexo WHERE id = @id`, { id }
      );
      if (!r.length) return res.status(404).json({ message: 'Anexo nao encontrado.' });

      // Apaga do banco primeiro (autoritativo). Arquivo fisico em best-effort.
      await Pg.connectAndQuery(`DELETE FROM tab_cobranca_anexo WHERE id = @id`, { id });

      try {
        const safeRel = String(r[0].arquivo_path).replace(/\\/g, '/');
        if (!safeRel.includes('..') && !path.isAbsolute(safeRel)) {
          const fullPath = path.join(UPLOAD_ROOT, safeRel);
          if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
        }
      } catch (e) {
        console.warn('Falha ao apagar arquivo fisico (registro removido OK):', e.message);
      }

      return res.json({ ok: true });
    } catch (err) {
      console.error('Erro cobranca/anexo delete:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
