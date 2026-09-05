// POST /ciosp/importar  (multipart: campo 'arquivo' = .xlsx)
// Query/body: edicao (default 'CIOSP 2026'), limpar=true|false (apaga a edição antes).
// Importa a "MATRIZ CIOSP" inteira (3 abas) de uma vez. Perm 19002. Auditoria.

const multer = require('multer');
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([19002, 0]);
const Auditoria = require('../../services/auditoria');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

module.exports = (app) => ({
  verb: 'post',
  route: '/importar',
  middlewares: [requirePerm(app), upload.single('arquivo')],

  handler: async (req, res) => {
    const user = req.user && req.user[0];
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ message: 'Arquivo .xlsx obrigatório (campo "arquivo").' });
    }
    const edicao = String(req.body?.edicao || req.query?.edicao || 'CIOSP 2026').trim().slice(0, 40);
    const limpar = ['1', 'true', 'sim'].includes(String(req.body?.limpar || req.query?.limpar || '').toLowerCase());

    try {
      const Ingest = require('../../services/ciospIngest');
      const r = await Ingest.importar(app, {
        buffer: req.file.buffer, edicao, limpar, criadoPor: user?.id ? Number(user.id) : null
      });
      Auditoria.registrar(app, {
        modulo: 'CIOSP', submodulo: 'Importar', acao: 'IMPORTAR', severidade: 'AVISO',
        req, entidade: 'edicao', entidadeId: edicao,
        descricao: `Importou ${r.importadas} vendas do CIOSP (${edicao})${limpar ? ' [substituiu]' : ''}`
      });
      return res.json({ ok: true, ...r });
    } catch (err) {
      console.error('ciosp/importar:', err.message);
      return res.status(500).json({ message: 'Erro ao importar planilha: ' + err.message });
    }
  }
});
