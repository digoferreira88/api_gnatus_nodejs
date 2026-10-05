// POST /cobranca/omni/importar  — upload da planilha diária da Omni (campo 'arquivo').
// Opcional no body: dataRef (YYYY-MM-DD; default hoje p/ carteira, período do arquivo p/ recompra).
// Detecta carteira (xlsx do portal) x recompra (.xls/HTML) pelo conteúdo. Perm 9008.
const multer = require('multer');
const { parseArquivo } = require('../../services/omniImport');
const { salvarImportacao } = require('../../services/omniCarteira');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([9008, 0]);

module.exports = (app) => ({
  verb: 'post',
  route: '/omni/importar',
  middlewares: [requirePerm(app), upload.single('arquivo')],
  handler: async (req, res) => {
    const user = req.user && req.user[0];
    if (!req.file || !req.file.buffer) return res.status(400).json({ message: 'Arquivo não enviado (campo "arquivo").' });

    let parsed;
    try {
      parsed = await parseArquivo(req.file.buffer, req.file.originalname);
    } catch (e) {
      console.error('omni-importar parse:', e.message);
      return res.status(400).json({ message: 'Não consegui ler a planilha: ' + e.message });
    }
    if (!parsed.linhas.length) return res.status(400).json({ message: 'Nenhum contrato encontrado no arquivo (confira se é a planilha certa).' });

    const dataRef = (req.body && String(req.body.dataRef || '').trim()) || null;
    try {
      const r = await salvarImportacao(app, { parsed, dataRef, arquivoNome: req.file.originalname, user });
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error('omni-importar salvar:', e);
      return res.status(500).json({ message: 'Erro ao gravar a importação: ' + e.message });
    }
  }
});
