// POST /ciosp/midia  (multipart: 'arquivo' + edicao, tipo, titulo, codigo | secao | preco_id)
// Foto: ligada a um código impresso (aparece em toda linha com aquele código) ou a uma
// linha da tabela (preco_id — para os consultórios sem código). Catálogo: ligado a
// uma seção. Perm 19004.

const multer = require('multer');
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([19004, 0]);
const Auditoria = require('../../services/auditoria');
const Midia = require('../../services/ciospMidia');
const Edicao = require('../../services/ciospEdicao');

const LIMITE_FOTO = 2 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

module.exports = (app) => ({
  verb: 'post',
  route: '/midia',
  middlewares: [requirePerm(app), upload.single('arquivo')],

  handler: async (req, res) => {
    const user = req.user && req.user[0];
    const b = req.body || {};
    const f = req.file;
    if (!f || !f.buffer) return res.status(400).json({ message: 'Envie o arquivo no campo "arquivo".' });
    const edicao = String(b.edicao || '').trim();
    if (!edicao) return res.status(400).json({ message: 'Informe a edição.' });
    const tipo = String(b.tipo || '').trim();
    if (!['foto', 'catalogo'].includes(tipo)) return res.status(400).json({ message: 'Tipo deve ser foto ou catalogo.' });
    const titulo = String(b.titulo || f.originalname || '').trim().slice(0, 200) || null;
    const codigo = String(b.codigo || '').trim().slice(0, 60) || null;
    const secao = String(b.secao || '').trim().slice(0, 60) || null;
    const precoId = b.preco_id ? Number(b.preco_id) : null;

    if (tipo === 'foto') {
      if (!f.mimetype.startsWith('image/')) return res.status(400).json({ message: 'A foto deve ser uma imagem.' });
      if (f.size > LIMITE_FOTO) return res.status(400).json({ message: 'A foto passa de 2 MB — envie pela tela, que reduz antes.' });
      if (!codigo && !precoId) return res.status(400).json({ message: 'Ligue a foto a um código ou a uma linha da tabela.' });
    } else {
      if (f.mimetype !== 'application/pdf') return res.status(400).json({ message: 'O catálogo deve ser PDF.' });
      if (!secao) return res.status(400).json({ message: 'Ligue o catálogo a uma seção da tabela.' });
    }

    try {
      if (precoId) {
        const [l] = await Edicao.q(app, `SELECT 1 FROM tab_ciosp_preco WHERE id = $1 AND edicao = $2 AND ativo`, [precoId, edicao]);
        if (!l) return res.status(400).json({ message: 'Linha da tabela não encontrada nesta edição.' });
      }
      const g = await Midia.gravar(f.buffer, f.mimetype);
      const [m] = await Edicao.q(app,
        `INSERT INTO tab_ciosp_midia (edicao, tipo, titulo, arquivo, mime, bytes, codigo, secao, enviado_por)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [edicao, tipo, titulo, g.arquivo, f.mimetype, g.bytes, tipo === 'foto' ? codigo : null,
          tipo === 'catalogo' ? secao : null, user?.id ? Number(user.id) : null]);
      if (precoId) await Edicao.q(app, `UPDATE tab_ciosp_preco SET foto_id = $1 WHERE id = $2`, [m.id, precoId]);
      await Edicao.tocarVersao(app, edicao);
      Auditoria.registrar(app, {
        modulo: 'CIOSP', submodulo: 'Fotos e catálogos', acao: 'ENVIAR', severidade: 'INFO',
        req, entidade: 'midia', entidadeId: m.id,
        descricao: `${edicao}: ${tipo} "${titulo}" (${Math.round(g.bytes / 1024)} KB)`
      });
      return res.json({ ok: true, id: m.id, arquivo: g.arquivo, url: `/api/ciosp/midia-arquivo/${g.arquivo}` });
    } catch (err) {
      if (/tipo de arquivo/.test(err.message)) return res.status(400).json({ message: err.message });
      console.error('ciosp/midia (enviar):', err.message);
      return res.status(500).json({ message: 'Erro ao enviar o arquivo: ' + err.message });
    }
  }
});
