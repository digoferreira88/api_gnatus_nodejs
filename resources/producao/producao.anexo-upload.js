// Upload de anexo BINARIO de um registro de producao para SharePoint.
// POST multipart/form-data /producao/registro/:id/anexo-upload
//   campos: arquivo (file), titulo (text, opcional), tipo (text, opcional),
//           etapaCodigo (text 1..12, opcional)
//
// Storage: site SharePoint /sites/Pipefy, biblioteca Documentos.
// Path no SP: "Producao Intranet/{ano}/{op}_{serie}/etapa-{NN}_{nome-sanitizado}.ext"
// Inspirado no Zapier que ja faz isso pra cards Pipefy hoje.
//
// Permissao: 14001 (Producao - editar).
// Limite: 4MB por arquivo (graphFiles.uploadFile usa Graph PUT simples).

const multer = require('multer');
const Graph = require('../../services/graphFiles');
const Auditoria = require('../../services/auditoria');

const MAX_MB = 4;  // Graph PUT simples = ate 4MB. >4MB precisa upload session.
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

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([14001]);

const sanitizeNome = (s) => String(s || 'arquivo')
  .replace(/[^a-zA-Z0-9._-]+/g, '_')
  .replace(/_+/g, '_')
  .replace(/^_|_$/g, '')
  .slice(0, 150) || 'arquivo';

module.exports = (app) => ({
  verb: 'post',
  route: '/registro/:id/anexo-upload',
  middlewares: [requirePerm(app), upload],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Nao autenticado.' });

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'ID invalido.' });
    if (!req.file) return res.status(400).json({ message: 'Arquivo nao enviado (campo "arquivo" obrigatorio).' });

    const titulo = String(req.body?.titulo || req.file.originalname || '').trim().slice(0, 200);
    const tipo = String(req.body?.tipo || 'outros').trim().slice(0, 50);
    const etapaCodigo = req.body?.etapaCodigo != null && req.body.etapaCodigo !== ''
      ? Number(req.body.etapaCodigo) : null;
    if (etapaCodigo != null && (!Number.isInteger(etapaCodigo) || etapaCodigo < 1 || etapaCodigo > 12)) {
      return res.status(400).json({ message: 'etapaCodigo invalido (1..12).' });
    }
    if (!titulo) return res.status(400).json({ message: 'titulo obrigatorio.' });

    try {
      // Carrega registro pra montar path com op + numero serie
      const regRows = await Pg.connectAndQuery(
        `SELECT op_protheus, op_filial, numeros_serie, criado_em
           FROM tab_prod_registro WHERE id = @id`,
        { id }
      );
      if (!regRows.length) return res.status(404).json({ message: 'Registro nao encontrado.' });
      const reg = regRows[0];

      const ano = new Date(reg.criado_em || Date.now()).getFullYear();
      const op = sanitizeNome(reg.op_protheus);
      const serie = sanitizeNome((Array.isArray(reg.numeros_serie) ? reg.numeros_serie[0] : '') || 'sem-serie');
      const etapaPrefix = etapaCodigo != null
        ? `etapa-${String(etapaCodigo).padStart(2, '0')}_`
        : 'global_';
      const tsSufixo = String(Date.now()).slice(-6);  // evita colisao se 2 uploads tiverem mesmo nome
      const nomeArquivo = `${etapaPrefix}${tsSufixo}_${sanitizeNome(req.file.originalname)}`;
      const spPath = `Producao Intranet/${ano}/${op}_${serie}/${nomeArquivo}`;

      // Upload pro SharePoint
      let up;
      try {
        up = await Graph.uploadFile({
          path: spPath,
          buffer: req.file.buffer,
          mime: req.file.mimetype
        });
      } catch (err) {
        console.error('producao/anexo-upload Graph erro:', err.response?.data || err.message);
        return res.status(502).json({
          message: 'Falha no upload pro SharePoint: ' + (err.response?.data?.error?.message || err.message)
        });
      }

      // Grava metadata no PG
      const ins = await Pg.connectAndQuery(`
        INSERT INTO tab_prod_registro_anexo (
          registro_id, etapa_codigo, titulo, url, tipo,
          origem, sharepoint_drive_id, sharepoint_item_id, sharepoint_path,
          nome_original, mime_type, tamanho_bytes, enviado_por
        ) VALUES (
          @id, @ec, @tit, @url, @tipo,
          'sharepoint', @did, @iid, @path,
          @nome, @mime, @tam, @uid
        )
        RETURNING id, enviado_em`,
        {
          id, ec: etapaCodigo, tit: titulo, url: up.web_url, tipo,
          did: up.drive_id, iid: up.item_id, path: up.path,
          nome: req.file.originalname.slice(0, 300),
          mime: req.file.mimetype, tam: req.file.size, uid: user.ID
        }
      );

      Auditoria.registrar(app, {
        modulo: 'Producao', submodulo: 'Anexo', acao: 'CREATE',
        severidade: 'INFO', req,
        entidade: 'prod_registro_anexo', entidadeId: ins[0].id,
        descricao: `Upload "${req.file.originalname}" (${req.file.size} bytes) em registro #${id}` +
                   (etapaCodigo ? ` etapa ${etapaCodigo}` : ' (global)'),
        meta: { sharepoint_path: spPath, mime: req.file.mimetype }
      });

      return res.json({
        ok: true,
        id: ins[0].id,
        web_url: up.web_url,
        sharepoint_path: spPath,
        tamanho: req.file.size
      });
    } catch (err) {
      console.error('Erro producao/anexo-upload:', err);
      return res.status(500).json({ message: 'Erro ao gravar anexo: ' + err.message });
    }
  }
});
