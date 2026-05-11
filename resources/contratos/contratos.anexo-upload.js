// POST /contratos/:id/anexos — upload de PDF/documento ao contrato
// Multipart: campo 'arquivo'. Body opcional: descricao.

const multer = require('multer');
const Auditoria = require('../../services/auditoria');
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([5003]);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const trim = (v) => v == null ? null : String(v).trim() || null;

module.exports = (app) => ({
  verb: 'post',
  route: '/:id/anexos',
  middlewares: [requirePerm(app), upload.single('arquivo')],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'id invalido.' });
    if (!req.file || !req.file.buffer) return res.status(400).json({ message: 'arquivo obrigatorio.' });

    try {
      const cur = await Pg.connectAndQuery(`SELECT numero FROM tab_contrato WHERE id = @id`, { id });
      if (!cur.length) return res.status(404).json({ message: 'Contrato nao encontrado.' });

      const r = await Pg.connectAndQuery(`
        INSERT INTO tab_contrato_anexo (id_contrato, nome_arquivo, mime_type, tamanho_bytes, conteudo, descricao, id_user)
        VALUES (@id, @nome, @mime, @tam, @bin, @desc, @uid)
        RETURNING id`,
        {
          id, nome: req.file.originalname, mime: req.file.mimetype,
          tam: req.file.size, bin: req.file.buffer,
          desc: trim(req.body?.descricao), uid: user?.ID || null
        }
      );

      Auditoria.registrar(app, {
        modulo: 'ApoioGerencial', submodulo: 'Contratos',
        acao: 'UPLOAD_ANEXO', severidade: 'INFO',
        req, entidade: 'contrato', entidadeId: String(id),
        descricao: `Anexou "${req.file.originalname}" (${(req.file.size/1024).toFixed(0)}KB) ao contrato ${cur[0].numero}`,
        meta: { anexo_id: r[0].id, nome: req.file.originalname, tamanho: req.file.size }
      });

      return res.json({ ok: true, id: r[0].id });
    } catch (err) {
      console.error('contratos/anexo-upload:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
