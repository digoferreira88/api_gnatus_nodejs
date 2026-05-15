// POST /producao/instrucoes/produto/:codigo/upload
// Cadastra/substitui instrucao de trabalho de um produto pra uma etapa.
// Body multipart: arquivo (file), titulo (text, opcional), etapaCodigo (1..12 ou vazio=geral)
//
// Comportamento UPSERT: se ja existe instrucao pra (produto, etapa), apaga
// a anterior do SP e do PG antes de gravar a nova. Garante "1 PDF por
// (produto + etapa)".
//
// Path SP: "Instrucoes Produto/{codigo}/etapa-{NN}_{nome}.pdf"
// Permissao: 14002 (Producao - Admin).

const multer = require('multer');
const Graph = require('../../services/graphFiles');
const Auditoria = require('../../services/auditoria');

const MAX_MB = 4;
const TIPOS_PERMITIDOS = [
  'application/pdf',
  'image/jpeg', 'image/png', 'image/webp',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword', 'application/vnd.ms-excel'
];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!TIPOS_PERMITIDOS.includes(file.mimetype)) {
      return cb(new Error(`Tipo nao permitido: ${file.mimetype}.`));
    }
    cb(null, true);
  }
}).single('arquivo');

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([14002]);

const sanitize = (s) => String(s || 'instrucao')
  .replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 150) || 'instrucao';

module.exports = (app) => ({
  verb: 'post',
  route: '/instrucoes/produto/:codigo/upload',
  middlewares: [requirePerm(app), upload],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Nao autenticado.' });

    const codigo = String(req.params.codigo || '').trim();
    if (!codigo) return res.status(400).json({ message: 'produto codigo obrigatorio.' });
    if (!req.file) return res.status(400).json({ message: 'Arquivo nao enviado (campo "arquivo").' });

    const titulo = String(req.body?.titulo || req.file.originalname || '').trim().slice(0, 200);
    const etapaCodigo = req.body?.etapaCodigo != null && req.body.etapaCodigo !== ''
      ? Number(req.body.etapaCodigo) : null;
    if (etapaCodigo != null && (!Number.isInteger(etapaCodigo) || etapaCodigo < 1 || etapaCodigo > 12)) {
      return res.status(400).json({ message: 'etapaCodigo invalido (1..12 ou vazio pra geral).' });
    }
    if (!titulo) return res.status(400).json({ message: 'titulo obrigatorio.' });

    try {
      // Se ja existe pra esse (produto, etapa), apaga primeiro do SP + PG
      const existente = await Pg.connectAndQuery(`
        SELECT id, sharepoint_drive_id, sharepoint_item_id
          FROM tab_prod_instrucao
         WHERE produto_codigo = @cod
           AND ${etapaCodigo == null ? 'etapa_codigo IS NULL' : 'etapa_codigo = @ec'}`,
        { cod: codigo, ec: etapaCodigo }
      );
      for (const ex of existente) {
        try {
          await Graph.deleteFile({ drive_id: ex.sharepoint_drive_id, item_id: ex.sharepoint_item_id });
        } catch (e) {
          if (e.response?.status !== 404) console.warn('[instrucoes-upload] falha apagar SP antigo:', e.message);
        }
        await Pg.connectAndQuery(`DELETE FROM tab_prod_instrucao WHERE id = @id`, { id: ex.id });
      }

      // Upload novo
      const etapaPrefix = etapaCodigo != null ? `etapa-${String(etapaCodigo).padStart(2, '0')}_` : 'geral_';
      const nomeArquivo = `${etapaPrefix}${sanitize(req.file.originalname)}`;
      const spPath = `Instrucoes Produto/${sanitize(codigo)}/${nomeArquivo}`;

      const up = await Graph.uploadFile({ path: spPath, buffer: req.file.buffer, mime: req.file.mimetype });

      const ins = await Pg.connectAndQuery(`
        INSERT INTO tab_prod_instrucao (
          produto_codigo, etapa_codigo, titulo,
          sharepoint_drive_id, sharepoint_item_id, sharepoint_path, web_url,
          nome_original, mime_type, tamanho_bytes,
          criado_por, atualizado_por
        ) VALUES (
          @cod, @ec, @tit,
          @did, @iid, @path, @url,
          @nome, @mime, @tam,
          @uid, @uid
        )
        RETURNING id, criado_em`,
        {
          cod: codigo, ec: etapaCodigo, tit: titulo,
          did: up.drive_id, iid: up.item_id, path: up.path, url: up.web_url,
          nome: req.file.originalname.slice(0, 300),
          mime: req.file.mimetype, tam: req.file.size, uid: user.ID
        }
      );

      Auditoria.registrar(app, {
        modulo: 'Producao', submodulo: 'Instrucao', acao: existente.length ? 'UPDATE' : 'CREATE',
        severidade: 'INFO', req,
        entidade: 'prod_instrucao', entidadeId: ins[0].id,
        descricao: `${existente.length ? 'Substituiu' : 'Cadastrou'} instrucao "${req.file.originalname}" do produto ${codigo}` +
                   (etapaCodigo ? ` etapa ${etapaCodigo}` : ' (geral)'),
        meta: { produto: codigo, etapa: etapaCodigo, sharepoint_path: spPath }
      });

      return res.json({ ok: true, id: ins[0].id, web_url: up.web_url, sharepoint_path: spPath });
    } catch (err) {
      console.error('Erro producao/instrucoes-upload:', err);
      return res.status(500).json({ message: 'Erro ao gravar instrucao: ' + err.message });
    }
  }
});
