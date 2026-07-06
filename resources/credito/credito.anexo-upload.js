// Upload de consulta externa (arquivo) na Análise de Crédito.
// POST multipart/form-data /credito/anexo/:cod/:loja
//   campos: arquivo (file), titulo (text, opcional — default nome do arquivo)
//
// Storage: SharePoint /sites/Pipefy, path "Credito Consultas/{ano}/{cod}-{loja}/...".
// Metadata em tab_credito_anexo (migration 70). Mesmo padrão dos anexos de Produção.
// Permissão: 15100 (Crédito — consultar análise). Limite 4MB (Graph PUT simples).

const multer = require('multer');
const Graph = require('../../services/graphFiles');
const Auditoria = require('../../services/auditoria');

const MAX_MB = 4;
const TIPOS_PERMITIDOS = [
  'application/pdf',
  'image/jpeg', 'image/png', 'image/webp',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'text/plain', 'text/csv'
];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!TIPOS_PERMITIDOS.includes(file.mimetype)) {
      return cb(new Error(`Tipo nao permitido: ${file.mimetype}. Aceitos: PDF, JPG, PNG, WEBP, XLS(X), DOC(X), TXT, CSV.`));
    }
    cb(null, true);
  }
}).single('arquivo');

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([15100]);
const trim = (v) => String(v == null ? '' : v).trim();
const sanitizeNome = (s) => String(s || 'arquivo')
  .replace(/[^a-zA-Z0-9._-]+/g, '_')
  .replace(/_+/g, '_')
  .replace(/^_|_$/g, '')
  .slice(0, 150) || 'arquivo';

module.exports = (app) => ({
  verb: 'post',
  route: '/anexo/:cod/:loja',
  middlewares: [requirePerm(app), upload],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Nao autenticado.' });

    const cod = trim(req.params.cod), loja = trim(req.params.loja);
    if (!cod || !loja) return res.status(400).json({ message: 'cod e loja sao obrigatorios.' });
    if (!req.file) return res.status(400).json({ message: 'Arquivo nao enviado (campo "arquivo" obrigatorio).' });

    const titulo = trim(req.body?.titulo || req.file.originalname).slice(0, 200);

    try {
      const ano = new Date().getFullYear();
      const tsSufixo = String(Date.now()).slice(-6);   // evita colisao de nome
      const spPath = `Credito Consultas/${ano}/${sanitizeNome(cod)}-${sanitizeNome(loja)}/${tsSufixo}_${sanitizeNome(req.file.originalname)}`;

      let up;
      try {
        up = await Graph.uploadFile({ path: spPath, buffer: req.file.buffer, mime: req.file.mimetype });
      } catch (err) {
        console.error('credito/anexo-upload Graph erro:', err.response?.data || err.message);
        return res.status(502).json({
          message: 'Falha no upload pro SharePoint: ' + (err.response?.data?.error?.message || err.message)
        });
      }

      const ins = await Pg.connectAndQuery(`
        INSERT INTO tab_credito_anexo (
          cliente_cod, cliente_loja, titulo, nome_original, mime_type, tamanho_bytes,
          sharepoint_drive_id, sharepoint_item_id, sharepoint_path, url, enviado_por
        ) VALUES (@cod, @loja, @tit, @nome, @mime, @tam, @did, @iid, @path, @url, @uid)
        RETURNING id, enviado_em`,
        {
          cod, loja, tit: titulo,
          nome: req.file.originalname.slice(0, 300), mime: req.file.mimetype, tam: req.file.size,
          did: up.drive_id, iid: up.item_id, path: up.path, url: up.web_url, uid: user.ID
        });

      Auditoria.registrar(app, {
        modulo: 'Crédito', submodulo: 'Anexo', acao: 'CREATE', severidade: 'INFO', req,
        entidade: 'credito_anexo', entidadeId: ins[0].id,
        descricao: `Anexou consulta externa "${req.file.originalname}" (${req.file.size} bytes) no cliente ${cod}/${loja}`,
        meta: { sharepoint_path: spPath, mime: req.file.mimetype }
      });

      return res.json({ ok: true, id: ins[0].id, enviado_em: ins[0].enviado_em, web_url: up.web_url });
    } catch (err) {
      console.error('Erro credito/anexo-upload:', err);
      return res.status(500).json({ message: 'Erro ao gravar anexo: ' + err.message });
    }
  }
});
