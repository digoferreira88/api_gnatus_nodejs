// POST /treinamentos/admin/convite/:id — ações sobre um convite: reenviar | remover.
// Perm 20001.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([20001, 0]);
const Auditoria = require('../../services/auditoria');
const Treina = require('../../services/treinamentos');
const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'post',
  route: '/admin/convite/:id',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const id = Number(req.params.id) || 0;
    const acao = trim((req.body || {}).acao);
    const mensagem = trim((req.body || {}).mensagem) || null;
    if (!id) return res.status(400).json({ message: 'Convite inválido.' });
    if (!['reenviar', 'remover'].includes(acao)) return res.status(400).json({ message: 'Ação inválida.' });

    try {
      const cv = await Pg.connectAndQuery(
        `SELECT id, treinamento_id, email, nome, token FROM tab_treina_convite WHERE id=@id`, { id });
      if (!cv.length) return res.status(404).json({ message: 'Convite não encontrado.' });
      const convite = cv[0];

      if (acao === 'remover') {
        await Pg.connectAndQuery(`DELETE FROM tab_treina_convite WHERE id=@id`, { id });
        Auditoria.registrar(app, {
          modulo: 'Treinamentos', submodulo: 'Convites', acao: 'REMOVER', severidade: 'INFO',
          req, entidade: 'convite', entidadeId: String(id),
          descricao: `Removeu convite de ${convite.email} (treinamento #${convite.treinamento_id})`
        });
        return res.json({ ok: true, removido: true });
      }

      // reenviar
      const tr = await Pg.connectAndQuery(
        `SELECT id, titulo, objetivo, descricao, instrutor, setor_responsavel, local_padrao,
                teams_link, modalidades, status
           FROM tab_treina_treinamento WHERE id=@tid`, { tid: convite.treinamento_id });
      if (!tr.length) return res.status(404).json({ message: 'Treinamento não encontrado.' });
      const sessoes = await Pg.connectAndQuery(
        `SELECT id, data, hora_inicio, hora_fim, local, teams_link
           FROM tab_treina_sessao WHERE treinamento_id=@tid AND status='agendada'
          ORDER BY data, hora_inicio`, { tid: convite.treinamento_id });

      const r = await Treina.enviarConvite(app, {
        treinamento: tr[0], sessoes, email: convite.email, nome: convite.nome, mensagem,
        link: convite.token ? Treina.linkConvite(convite.token) : undefined
      });
      if (!r.ok && !r.skip) return res.status(502).json({ message: 'Falha ao enviar: ' + (r.erro || 'erro') });
      await Pg.connectAndQuery(`UPDATE tab_treina_convite SET reenviado_em=NOW() WHERE id=@id`, { id });

      Auditoria.registrar(app, {
        modulo: 'Treinamentos', submodulo: 'Convites', acao: 'REENVIAR', severidade: 'INFO',
        req, entidade: 'convite', entidadeId: String(id),
        descricao: `Reenviou convite para ${convite.email} (treinamento #${convite.treinamento_id})`
      });
      return res.json({ ok: true, enviado: !r.skip, emailAtivo: !r.skip });
    } catch (err) {
      console.error('treinamentos/admin-convite:', err.message);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
