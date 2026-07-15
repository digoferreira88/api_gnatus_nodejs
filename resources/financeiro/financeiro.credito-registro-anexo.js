// POST multipart /financeiro/credito-registro/:grupo/anexo
//   campos: arquivo (file), titulo (opcional)
// Anexa documento que fundamentou a decisão (IR, comprovante, contrato social,
// balanço, DRE, docs do fiador...) ao registro da análise (grupo). Storage:
// SharePoint /sites/Pipefy, "Credito Registros/{ano}/{grupo}/...". Metadata em
// tab_credito_anexo (registro_id = grupo). Perm 8006. Limite 4MB.

const multer = require('multer');
const Graph = require('../../services/graphFiles');
const Auditoria = require('../../services/auditoria');

const MAX_MB = 4;
const TIPOS_PERMITIDOS = [
  'application/pdf', 'image/jpeg', 'image/png', 'image/webp',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword',
  'text/plain', 'text/csv'
];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!TIPOS_PERMITIDOS.includes(file.mimetype)) {
      return cb(new Error(`Tipo não permitido: ${file.mimetype}. Aceitos: PDF, JPG, PNG, WEBP, XLS(X), DOC(X), TXT, CSV.`));
    }
    cb(null, true);
  }
}).single('arquivo');

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([8006]);
const trim = (v) => String(v == null ? '' : v).trim();
const sanitizeNome = (s) => String(s || 'arquivo')
  .replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 150) || 'arquivo';

module.exports = (app) => ({
  verb: 'post',
  route: '/credito-registro/:grupo/anexo',
  middlewares: [requirePerm(app), upload],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Não autenticado.' });

    const grupo = Number(req.params.grupo);
    if (!Number.isInteger(grupo) || grupo <= 0) return res.status(400).json({ message: 'grupo inválido.' });
    if (!req.file) return res.status(400).json({ message: 'Arquivo não enviado (campo "arquivo").' });

    // valida que o grupo existe
    const g = await Pg.connectAndQuery(`SELECT 1 FROM tab_credito_registro WHERE grupo_id = @g LIMIT 1`, { g: grupo });
    if (!g.length) return res.status(404).json({ message: 'Registro de análise não encontrado.' });

    const titulo = trim(req.body?.titulo || req.file.originalname).slice(0, 200);

    try {
      const ano = new Date().getFullYear();
      const tsSufixo = String(Date.now()).slice(-6);
      const spPath = `Credito Registros/${ano}/${grupo}/${tsSufixo}_${sanitizeNome(req.file.originalname)}`;

      let up;
      try {
        up = await Graph.uploadFile({ path: spPath, buffer: req.file.buffer, mime: req.file.mimetype });
      } catch (err) {
        console.error('credito-registro/anexo Graph erro:', err.response?.data || err.message);
        return res.status(502).json({ message: 'Falha no upload pro SharePoint: ' + (err.response?.data?.error?.message || err.message) });
      }

      const ins = await Pg.connectAndQuery(`
        INSERT INTO tab_credito_anexo (
          cliente_cod, cliente_loja, registro_id, titulo, nome_original, mime_type, tamanho_bytes,
          sharepoint_drive_id, sharepoint_item_id, sharepoint_path, url, enviado_por
        ) VALUES ('', '', @grupo, @tit, @nome, @mime, @tam, @did, @iid, @path, @url, @uid)
        RETURNING id, enviado_em`,
        {
          grupo, tit: titulo, nome: req.file.originalname.slice(0, 300),
          mime: req.file.mimetype, tam: req.file.size,
          did: up.drive_id, iid: up.item_id, path: up.path, url: up.web_url, uid: user.ID
        });

      Auditoria.registrar(app, {
        modulo: 'Financeiro', submodulo: 'RegistroCredito', acao: 'ANEXO_CREATE', severidade: 'INFO', req,
        entidade: 'credito_anexo', entidadeId: String(ins[0].id),
        descricao: `Anexou "${req.file.originalname}" (${req.file.size} bytes) ao registro de análise ${grupo}`,
        meta: { grupo, sharepoint_path: spPath, mime: req.file.mimetype }
      });

      return res.json({ ok: true, id: ins[0].id, enviadoEm: ins[0].enviado_em, url: up.web_url });
    } catch (err) {
      console.error('financeiro/credito-registro anexo:', err);
      return res.status(500).json({ message: 'Erro ao gravar anexo: ' + err.message });
    }
  }
});
