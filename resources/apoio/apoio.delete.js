// DELETE /apoio/apresentacoes/:id — remove uma apresentacao salva.
// Permissao 5001. Nao-admin so deleta as proprias.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([5001]);
const Auditoria = require('../../services/auditoria');

module.exports = (app) => ({
  verb: 'delete',
  route: '/apresentacoes/:id',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'id invalido.' });

    try {
      const rows = await Pg.connectAndQuery(
        `SELECT id, id_user, titulo, nome_arquivo FROM tab_apoio_apresentacao WHERE id = @id`,
        { id }
      );
      if (!rows.length) return res.status(404).json({ message: 'Apresentacao nao encontrada.' });
      const a = rows[0];

      const isAdmin = await Pg.connectAndQuery(
        `SELECT 1 FROM tab_intranet_usr_permissoes WHERE id_user = @uid AND id_permissao = 0 LIMIT 1`,
        { uid: user.ID }
      );
      if (a.id_user !== user.ID && !isAdmin.length) {
        return res.status(403).json({ message: 'Sem permissao para excluir esta apresentacao.' });
      }

      await Pg.connectAndQuery(`DELETE FROM tab_apoio_apresentacao WHERE id = @id`, { id });

      Auditoria.registrar(app, {
        modulo: 'ApoioGerencial', submodulo: 'Apresentacao',
        acao: 'DELETE', severidade: 'INFO',
        req, entidade: 'apoio_apresentacao', entidadeId: String(id),
        descricao: `Excluiu apresentacao "${a.titulo}" (arquivo ${a.nome_arquivo})`
      });
      return res.json({ ok: true });
    } catch (err) {
      console.error('apoio/delete:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
