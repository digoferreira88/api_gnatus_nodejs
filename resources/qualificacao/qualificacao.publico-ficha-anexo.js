// POST /qualificacao/publico/ficha/:token/anexo — o FORNECEDOR anexa um documento da seção
// "Documentação do fornecedor" do FORM 7.3.21/7.3.28 (multipart: arquivo + tipoId). O arquivo
// fica preso à ficha; só vira documento da qualificação quando a Engenharia o confere e
// registra (com número e validade). ANÔNIMO, com limite por IP; PDF ou imagem, até 10 MB.

const multer = require('multer');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const Q = require('../../services/qfCore');
const R = require('../../services/qfRegras');

const TIPOS_ACEITOS = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
const upload = multer({
  storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => cb(null, TIPOS_ACEITOS.includes(file.mimetype))
});
const limitador = rateLimit({ windowMs: 15 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false, message: { message: 'Muitos envios. Tente em alguns minutos.' } });

module.exports = (app) => ({
  verb: 'post',
  route: '/publico/ficha/:token/anexo',
  anonymous: true,
  middlewares: [limitador, (req, res, next) => upload.single('arquivo')(req, res, (err) => {
    if (err) return res.status(400).json({ message: err.code === 'LIMIT_FILE_SIZE' ? 'Arquivo maior que 10 MB.' : 'Não foi possível receber o arquivo.' });
    next();
  })],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const token = Q.trim(req.params.token);
    if (!/^[0-9a-f]{48}$/.test(token)) return res.status(404).json({ message: 'Link inválido.' });
    if (!req.file) return res.status(400).json({ message: 'Envie um PDF ou imagem (JPG, PNG ou WEBP) de até 10 MB.' });
    try {
      const [ficha] = await Pg.connectAndQuery(`SELECT * FROM tab_qf_ficha WHERE token = @t`, { t: token });
      if (!ficha) return res.status(404).json({ message: 'Link inválido ou já utilizado.' });
      if (ficha.token_expira_em && new Date(ficha.token_expira_em) < new Date()) return res.status(410).json({ message: 'Este link expirou.' });
      if (!['RASCUNHO', 'ENVIADA', 'DEVOLVIDA', 'RESPONDIDA'].includes(ficha.status)) return res.status(409).json({ message: 'Este formulário já foi analisado.' });
      const [f] = await Pg.connectAndQuery(`SELECT * FROM tab_qf_fornecedor WHERE id = @id`, { id: ficha.fornecedor_id });
      const tipos = await Q.tiposDocumento(Pg);
      const tipo = R.documentosExigidos(tipos, f).map(x => x.tipo).find(t => t.id === Number((req.body || {}).tipoId));
      if (!tipo) return res.status(400).json({ message: 'Documento não previsto para este fornecedor.' });
      const [qtd] = await Pg.connectAndQuery(`SELECT COUNT(*)::int n FROM tab_qf_anexo WHERE entidade = 'ficha' AND entidade_id = @id`, { id: ficha.id });
      if (qtd.n >= 60) return res.status(400).json({ message: 'Limite de arquivos deste formulário atingido.' });
      const [a] = await Pg.connectAndQuery(
        `INSERT INTO tab_qf_anexo (entidade, entidade_id, fornecedor_id, categoria, nome_arquivo, mime_type, tamanho_bytes, sha256, conteudo, descricao, enviado_por_externo)
         VALUES ('ficha', @fid, @forn, 'DOCUMENTO', @nome, @mime, @tam, @sha, @bin, @desc, @ext)
         RETURNING id, nome_arquivo, tamanho_bytes, descricao`,
        { fid: ficha.id, forn: f.id, nome: req.file.originalname.slice(0, 255), mime: req.file.mimetype, tam: req.file.size,
          sha: crypto.createHash('sha256').update(req.file.buffer).digest('hex'), bin: req.file.buffer,
          desc: `${tipo.codigo} — ${tipo.nome}`.slice(0, 255), ext: `fornecedor (link público) · IP ${Q.ipDe(req) || '—'}` });
      await Q.log(Pg, null, { entidade: 'ficha', entidadeId: ficha.id, fornecedorId: f.id, acao: 'ANEXAR', mudancas: [{ campo: tipo.codigo, para: req.file.originalname }], motivo: 'enviado pelo fornecedor no link público' });
      return res.json({ ok: true, anexo: { id: a.id, nome_arquivo: a.nome_arquivo, tamanho_bytes: a.tamanho_bytes, descricao: a.descricao }, tipoId: tipo.id });
    } catch (err) { return Q.falha(res, 'receber o arquivo', err); }
  }
});
