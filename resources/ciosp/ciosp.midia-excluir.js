// DELETE /ciosp/midia/:id — tira uma foto ou catálogo da edição. O arquivo só sai do
// disco se nenhum outro registro ativo usar o mesmo conteúdo. Perm 19004.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([19004, 0]);
const Auditoria = require('../../services/auditoria');
const Midia = require('../../services/ciospMidia');
const Edicao = require('../../services/ciospEdicao');

module.exports = (app) => ({
  verb: 'delete',
  route: '/midia/:id',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: 'Id inválido.' });
    try {
      const [m] = await Edicao.q(app,
        `UPDATE tab_ciosp_midia SET ativo = false WHERE id = $1 AND ativo RETURNING edicao, arquivo, titulo, tipo`, [id]);
      if (!m) return res.status(404).json({ message: 'Arquivo não encontrado.' });
      await Edicao.q(app, `UPDATE tab_ciosp_preco SET foto_id = NULL WHERE foto_id = $1`, [id]);
      const [uso] = await Edicao.q(app, `SELECT 1 FROM tab_ciosp_midia WHERE arquivo = $1 AND ativo LIMIT 1`, [m.arquivo]);
      if (!uso) await Midia.apagar(m.arquivo);
      await Edicao.tocarVersao(app, m.edicao);
      Auditoria.registrar(app, {
        modulo: 'CIOSP', submodulo: 'Fotos e catálogos', acao: 'EXCLUIR', severidade: 'AVISO',
        req, entidade: 'midia', entidadeId: id, descricao: `${m.edicao}: ${m.tipo} "${m.titulo}"`
      });
      return res.json({ ok: true });
    } catch (err) {
      console.error('ciosp/midia (excluir):', err.message);
      return res.status(500).json({ message: 'Erro ao excluir: ' + err.message });
    }
  }
});
