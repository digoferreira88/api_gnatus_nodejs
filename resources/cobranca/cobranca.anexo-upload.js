// Upload de anexo de um cliente de cobranca (PDF de acordo de divida etc).
// Storage: disco da VPS em UPLOAD_DIR/cobranca/<cod>_<loja>/<timestamp>-<nome>.
// POST multipart/form-data /cobranca/cliente/:cod/:loja/anexo
//   campos: arquivo (file) + titulo (text)
//
// Permissao: 9001/9002 (qualquer perm de cobranca).

const fs = require('fs');
const path = require('path');
const multer = require('multer');

const UPLOAD_ROOT = process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads');
const TIPOS_PERMITIDOS = ['application/pdf', 'image/jpeg', 'image/png'];
const TAMANHO_MAX_MB = 15;

// Storage dinamico: pasta por cliente
const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const cod  = String(req.params.cod  || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
    const loja = String(req.params.loja || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
    if (!cod || !loja) return cb(new Error('cod/loja invalidos'), null);
    const dir = path.join(UPLOAD_ROOT, 'cobranca', `${cod}_${loja}`);
    fs.mkdir(dir, { recursive: true }, err => err ? cb(err, null) : cb(null, dir));
  },
  filename: (_req, file, cb) => {
    const ts = Date.now();
    const nome = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
    cb(null, `${ts}-${nome}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: TAMANHO_MAX_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!TIPOS_PERMITIDOS.includes(file.mimetype)) {
      return cb(new Error(`Tipo nao permitido: ${file.mimetype}. Aceitos: PDF, JPG, PNG.`));
    }
    cb(null, true);
  }
}).single('arquivo');

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([9001, 9002]);

module.exports = (app) => ({
  verb: 'post',
  route: '/cliente/:cod/:loja/anexo',
  middlewares: [requirePerm(app), upload],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user[0];

    const cod = String(req.params.cod || '').trim();
    const loja = String(req.params.loja || '').trim();
    const titulo = String(req.body?.titulo || '').trim();

    if (!req.file) return res.status(400).json({ message: 'Arquivo nao enviado.' });
    if (!titulo) {
      // remove arquivo orfao
      try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
      return res.status(400).json({ message: 'titulo obrigatorio.' });
    }

    // Path relativo (nao guarda absoluto pra ser portavel entre dev/prod)
    const relPath = path.relative(UPLOAD_ROOT, req.file.path).replace(/\\/g, '/');

    try {
      const ins = await Pg.connectAndQuery(
        `INSERT INTO tab_cobranca_anexo
            (cliente_cod, cliente_loja, titulo, arquivo_path, arquivo_nome_original, arquivo_tamanho, arquivo_mime, enviado_por)
         VALUES (@cod, @loja, @tit, @path, @nome, @tam, @mime, @uid)
         RETURNING id, enviado_em`,
        {
          cod, loja, tit: titulo, path: relPath,
          nome: req.file.originalname, tam: req.file.size, mime: req.file.mimetype, uid: user.ID
        }
      );
      return res.json({ ok: true, id: ins[0].id, tamanho: req.file.size });
    } catch (err) {
      // Rollback: remove arquivo se falhar
      try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
      console.error('Erro cobranca/anexo upload:', err);
      return res.status(500).json({ message: 'Erro ao gravar anexo: ' + err.message });
    }
  }
});
