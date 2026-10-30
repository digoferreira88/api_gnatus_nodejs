// POST /qualificacao/anexos/:anexoId/excluir — exclusão LÓGICA de anexo, com motivo.
// Quem enviou pode excluir nas primeiras 24 h (anexou errado); depois só a Qualidade.

const Q = require('../../services/qfCore');

module.exports = (app) => ({
  verb: 'post',
  route: '/anexos/:anexoId/excluir',
  middlewares: [Q.mw(app, 'inspetor')],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const id = Number(req.params.anexoId);
    const motivo = Q.nul((req.body || {}).motivo);
    if (!motivo) return res.status(400).json({ message: 'Informe o motivo.' });
    try {
      const niveis = await Q.niveisDoUsuario(Pg, req);
      const u = Q.usuario(req);
      const [a] = await Pg.connectAndQuery(`SELECT id, entidade, entidade_id, fornecedor_id, nome_arquivo, enviado_por, enviado_em, excluido FROM tab_qf_anexo WHERE id = @id`, { id });
      if (!a || a.excluido) return res.status(404).json({ message: 'Anexo não encontrado.' });
      if (a.entidade === 'documento') return res.status(400).json({ message: 'Arquivo de documento regulatório: exclua o documento (fica no histórico).' });
      const proprio = Number(a.enviado_por) === u.id && (Date.now() - new Date(a.enviado_em).getTime()) < 24 * 3600 * 1000;
      if (!proprio && !niveis.qualidade) return res.status(403).json({ message: 'Só a Qualidade exclui anexos depois de 24 h do envio.' });
      await Pg.connectAndQuery(`UPDATE tab_qf_anexo SET excluido = TRUE, excluido_motivo = @m, excluido_por = @u, excluido_em = NOW() WHERE id = @id`, { id, m: motivo, u: u.id });
      await Q.log(Pg, req, { entidade: a.entidade, entidadeId: a.entidade_id, fornecedorId: a.fornecedor_id, acao: 'EXCLUIR_ANEXO', mudancas: [{ campo: 'arquivo', de: a.nome_arquivo, para: null }], motivo });
      return res.json({ ok: true });
    } catch (err) { return Q.falha(res, 'excluir o anexo', err); }
  }
});
