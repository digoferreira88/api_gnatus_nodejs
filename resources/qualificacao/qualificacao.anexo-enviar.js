// POST /qualificacao/anexos — anexa arquivo a uma inspeção (fotos, laudo, RNC), auditoria
// (relatório), amostra, avaliação, processo ou fornecedor (plano de ação).
// Multipart: arquivo + entidade + entidade_id + categoria + descricao.
// Inspeção: Inspetor+ (23002); demais: Engenharia+ (23003).

const multer = require('multer');
const crypto = require('crypto');
const Q = require('../../services/qfCore');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const TABELA = {
  inspecao: 'tab_qf_inspecao', auditoria: 'tab_qf_auditoria', amostra: 'tab_qf_amostra', avaliacao: 'tab_qf_avaliacao',
  qualificacao: 'tab_qf_qualificacao', fornecedor: 'tab_qf_fornecedor', ficha: 'tab_qf_ficha'
};
const CATEGORIAS = ['FOTO', 'LAUDO', 'RNC', 'RELATORIO', 'PLANO_ACAO', 'OUTRO'];

module.exports = (app) => ({
  verb: 'post',
  route: '/anexos',
  middlewares: [Q.mw(app, 'inspetor'), upload.single('arquivo')],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const b = req.body || {};
    const entidade = Q.trim(b.entidade);
    const entId = Number(b.entidade_id);
    if (!TABELA[entidade] || !Number.isInteger(entId)) return res.status(400).json({ message: 'Entidade inválida.' });
    if (!req.file) return res.status(400).json({ message: 'Selecione o arquivo.' });
    try {
      const niveis = await Q.niveisDoUsuario(Pg, req);
      if (entidade !== 'inspecao' && !niveis.engenharia) return res.status(403).json({ message: 'Sem permissão para anexar neste registro.' });
      const [alvo] = await Pg.connectAndQuery(
        `SELECT id, ${entidade === 'fornecedor' ? 'id' : 'fornecedor_id'} AS fornecedor_id FROM ${TABELA[entidade]} WHERE id = @id`, { id: entId });
      if (!alvo) return res.status(404).json({ message: 'Registro não encontrado.' });
      const u = Q.usuario(req);
      const categoria = CATEGORIAS.includes(b.categoria) ? b.categoria : 'OUTRO';
      const [a] = await Pg.connectAndQuery(
        `INSERT INTO tab_qf_anexo (entidade, entidade_id, fornecedor_id, categoria, nome_arquivo, mime_type, tamanho_bytes, sha256, conteudo, descricao, enviado_por)
         VALUES (@e, @eid, @f, @cat, @nome, @mime, @tam, @sha, @bin, @desc, @u)
         RETURNING id, entidade, entidade_id, categoria, nome_arquivo, mime_type, tamanho_bytes, descricao, enviado_em`,
        { e: entidade, eid: entId, f: alvo.fornecedor_id, cat: categoria, nome: req.file.originalname.slice(0, 255), mime: req.file.mimetype,
          tam: req.file.size, sha: crypto.createHash('sha256').update(req.file.buffer).digest('hex'), bin: req.file.buffer,
          desc: Q.nul(b.descricao) ? Q.trim(b.descricao).slice(0, 255) : null, u: u.id });
      await Q.log(Pg, req, { entidade, entidadeId: entId, fornecedorId: alvo.fornecedor_id, acao: 'ANEXAR',
        mudancas: [{ campo: 'arquivo', para: `${req.file.originalname} (${categoria})` }] });
      return res.json({ ok: true, anexo: a });
    } catch (err) { return Q.falha(res, 'anexar o arquivo', err); }
  }
});
