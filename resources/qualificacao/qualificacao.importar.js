// POST /qualificacao/importar — importa as planilhas atuais (multipart: arquivo,
// tipo = lista | inspecoes, gravar = 1). Sem gravar=1 é SIMULAÇÃO: devolve o relatório
// (contagens, avisos por tipo, validação INFITEK) sem tocar no banco.
// Ordem recomendada: primeiro a FORM 7.3.24 (lista), depois a FORM 7.4.3.H.
// Perm 23006 (Administração).

const multer = require('multer');
const Q = require('../../services/qfCore');
const Imp = require('../../services/qfImport');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024 } });

module.exports = (app) => ({
  verb: 'post',
  route: '/importar',
  middlewares: [Q.mw(app, 'admin'), upload.single('arquivo')],

  handler: async (req, res) => {
    const b = req.body || {};
    if (!req.file) return res.status(400).json({ message: 'Selecione a planilha (.xlsx).' });
    if (!/\.xlsx$/i.test(req.file.originalname)) return res.status(400).json({ message: 'Envie o arquivo .xlsx (Excel).' });
    const gravar = String(b.gravar) === '1';
    try {
      const r = b.tipo === 'inspecoes'
        ? await Imp.importarInspecoes(app, req.file.buffer, { dryRun: !gravar, req })
        : await Imp.importarLista(app, req.file.buffer, { dryRun: !gravar, req });
      return res.json({ ok: true, arquivo: req.file.originalname, ...r });
    } catch (err) {
      if (/não encontrad|Colunas/.test(err.message)) return res.status(400).json({ message: err.message });
      return Q.falha(res, 'importar a planilha', err);
    }
  }
});
