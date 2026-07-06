// DELETE /credito/anexo/:id — remove uma consulta externa anexada.
// Só o AUTOR do upload ou admin (perm 0) pode remover. Apaga o arquivo do
// SharePoint (404 = ja apagado fora, segue) e depois o metadata no PG.

const Graph = require('../../services/graphFiles');
const Auditoria = require('../../services/auditoria');

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([15100]);

module.exports = (app) => ({
  verb: 'delete',
  route: '/anexo/:id',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Nao autenticado.' });

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'id invalido.' });

    try {
      const found = await Pg.connectAndQuery(`
        SELECT id, cliente_cod, cliente_loja, titulo, enviado_por,
               sharepoint_drive_id, sharepoint_item_id, sharepoint_path
          FROM tab_credito_anexo WHERE id = @id`, { id });
      if (!found.length) return res.status(404).json({ message: 'Anexo nao encontrado.' });
      const a = found[0];

      // autor ou admin
      if (Number(a.enviado_por) !== Number(user.ID)) {
        const adm = await Pg.connectAndQuery(
          `SELECT 1 FROM tab_intranet_usr_permissoes WHERE id_user = @id AND id_permissao = 0 LIMIT 1`,
          { id: user.ID });
        if (!adm.length) return res.status(403).json({ message: 'Só o autor do anexo (ou admin) pode remover.' });
      }

      let spStatus = 'nao_aplicavel';
      if (a.sharepoint_drive_id && a.sharepoint_item_id) {
        try {
          await Graph.deleteFile({ drive_id: a.sharepoint_drive_id, item_id: a.sharepoint_item_id });
          spStatus = 'apagado';
        } catch (err) {
          if (err.response?.status === 404) spStatus = 'ja_inexistente';
          else {
            console.error('credito/anexo-delete Graph erro:', err.response?.data || err.message);
            return res.status(502).json({
              message: 'Falha ao apagar do SharePoint: ' + (err.response?.data?.error?.message || err.message)
            });
          }
        }
      }

      await Pg.connectAndQuery(`DELETE FROM tab_credito_anexo WHERE id = @id`, { id });

      Auditoria.registrar(app, {
        modulo: 'Crédito', submodulo: 'Anexo', acao: 'DELETE', severidade: 'AVISO', req,
        entidade: 'credito_anexo', entidadeId: id,
        descricao: `Removeu consulta externa "${a.titulo}" do cliente ${a.cliente_cod}/${a.cliente_loja} (sharepoint=${spStatus})`,
        meta: { sharepoint_path: a.sharepoint_path || null }
      });

      return res.json({ ok: true, sharepoint: spStatus });
    } catch (err) {
      console.error('Erro credito/anexo DELETE:', err);
      return res.status(500).json({ message: 'Erro ao remover anexo: ' + err.message });
    }
  }
});
