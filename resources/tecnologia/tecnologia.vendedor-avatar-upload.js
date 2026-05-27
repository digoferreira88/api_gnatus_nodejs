// POST /tecnologia/vendedor-avatar
// Upload multipart/form-data com campos:
//   arquivo: file (WEBP/PNG/JPG, max 500 KB)
//   codigo: text (A3_COD do vendedor — com zeros a esquerda)
//   nome:   text (opcional — snapshot do nome pra auditoria)
//
// Upsert por codigo. Permissao 1028 (Gestao de Usuarios — Tecnologia).

const multer = require('multer');

const MAX_KB = 500;
const TIPOS_PERMITIDOS = new Set(['image/webp', 'image/png', 'image/jpeg', 'image/jpg']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_KB * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!TIPOS_PERMITIDOS.has(file.mimetype)) {
      return cb(new Error(`Tipo nao permitido: ${file.mimetype}. Aceitos: WEBP, PNG, JPG.`));
    }
    cb(null, true);
  }
}).single('arquivo');

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1028]);
const trim = (v) => String(v || '').trim();

// Wrapper pra retornar erros de multer como JSON com status correto (default eh 500).
const uploadWrap = (req, res, next) => upload(req, res, (err) => {
  if (!err) return next();
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ message: `Arquivo excede ${MAX_KB} KB.` });
  }
  return res.status(400).json({ message: err.message });
});

module.exports = (app) => ({
  verb: 'post',
  route: '/vendedor-avatar',
  middlewares: [requirePerm(app), uploadWrap],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Nao autenticado.' });

    const codigo = trim(req.body?.codigo);
    const nome   = trim(req.body?.nome);
    if (!codigo) return res.status(400).json({ message: 'Campo "codigo" obrigatorio.' });
    if (!req.file) return res.status(400).json({ message: 'Arquivo nao enviado (campo "arquivo" obrigatorio).' });

    const buf  = req.file.buffer;
    const mime = req.file.mimetype;
    const size = buf.length;

    try {
      const rows = await Pg.connectAndQuery(`
        INSERT INTO tab_vendedor_avatar (codigo, nome, mime_type, tamanho_bytes, bytes, atualizado_por)
        VALUES (@cod, @nome, @mime, @size, @bytes, @uid)
        ON CONFLICT (codigo) DO UPDATE
          SET nome           = COALESCE(EXCLUDED.nome, tab_vendedor_avatar.nome),
              mime_type      = EXCLUDED.mime_type,
              tamanho_bytes  = EXCLUDED.tamanho_bytes,
              bytes          = EXCLUDED.bytes,
              atualizado_por = EXCLUDED.atualizado_por,
              atualizado_em  = NOW()
        RETURNING codigo, nome, mime_type, tamanho_bytes, atualizado_em`,
        { cod: codigo, nome: nome || null, mime, size, bytes: buf, uid: user.ID });

      return res.json({ ok: true, avatar: rows[0] });
    } catch (err) {
      console.error('vendedor-avatar-upload:', err);
      return res.status(500).json({ message: 'Erro ao salvar avatar: ' + err.message });
    }
  }
});
