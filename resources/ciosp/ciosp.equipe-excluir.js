// DELETE /ciosp/equipe/:id — tira alguém da equipe do evento. Gerente que ainda tem
// vendedores ligados a ele não sai (409 com os nomes). Perm 19004.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([19004, 0]);
const Auditoria = require('../../services/auditoria');
const Edicao = require('../../services/ciospEdicao');

module.exports = (app) => ({
  verb: 'delete',
  route: '/equipe/:id',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: 'Id inválido.' });
    try {
      const [m] = await Edicao.q(app, `SELECT edicao, usuario_id, nome_exibicao FROM tab_ciosp_equipe WHERE id = $1`, [id]);
      if (!m) return res.status(404).json({ message: 'Membro não encontrado.' });
      const liderados = await Edicao.q(app,
        `SELECT nome_exibicao FROM tab_ciosp_equipe WHERE edicao = $1 AND gerente_id = $2`, [m.edicao, m.usuario_id]);
      if (liderados.length) {
        return res.status(409).json({
          message: `${m.nome_exibicao} ainda é gerente de: ${liderados.map(l => l.nome_exibicao).join(', ')}. Troque o gerente deles antes.`
        });
      }
      await Edicao.q(app, `DELETE FROM tab_ciosp_equipe WHERE id = $1`, [id]);
      await Edicao.tocarVersao(app, m.edicao);
      Auditoria.registrar(app, {
        modulo: 'CIOSP', submodulo: 'Equipe do evento', acao: 'EXCLUIR', severidade: 'AVISO',
        req, entidade: 'equipe', entidadeId: id, descricao: `${m.edicao}: ${m.nome_exibicao}`
      });
      return res.json({ ok: true });
    } catch (err) {
      console.error('ciosp/equipe (excluir):', err.message);
      return res.status(500).json({ message: 'Erro ao excluir o membro: ' + err.message });
    }
  }
});
