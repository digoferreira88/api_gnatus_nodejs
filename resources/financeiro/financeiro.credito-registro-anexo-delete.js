// DELETE /financeiro/credito-registro/anexo/:id — remove um anexo do registro.
// Só o autor do upload ou admin (perm 0). Apaga do SharePoint + metadata. Perm 8006.
// (o registro em si NUNCA é apagado — item 4; isto remove apenas um documento anexo.)

const Graph = require('../../services/graphFiles');
const Auditoria = require('../../services/auditoria');
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([8006]);

module.exports = (app) => ({
  verb: 'delete',
  route: '/credito-registro/anexo/:id',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Não autenticado.' });

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'id inválido.' });

    try {
      const found = await Pg.connectAndQuery(`
        SELECT id, registro_id, titulo, enviado_por, sharepoint_drive_id, sharepoint_item_id, sharepoint_path
          FROM tab_credito_anexo WHERE id = @id AND registro_id IS NOT NULL`, { id });
      if (!found.length) return res.status(404).json({ message: 'Anexo não encontrado.' });
      const a = found[0];

      if (Number(a.enviado_por) !== Number(user.ID)) {
        const adm = await Pg.connectAndQuery(
          `SELECT 1 FROM tab_intranet_usr_permissoes WHERE id_user = @id AND id_permissao = 0 LIMIT 1`, { id: user.ID });
        if (!adm.length) return res.status(403).json({ message: 'Só o autor do anexo (ou admin) pode remover.' });
      }

      let spStatus = 'nao_aplicavel';
      if (a.sharepoint_drive_id && a.sharepoint_item_id) {
        try { await Graph.deleteFile({ drive_id: a.sharepoint_drive_id, item_id: a.sharepoint_item_id }); spStatus = 'apagado'; }
        catch (err) {
          if (err.response?.status === 404) spStatus = 'ja_inexistente';
          else return res.status(502).json({ message: 'Falha ao apagar do SharePoint: ' + (err.response?.data?.error?.message || err.message) });
        }
      }

      await Pg.connectAndQuery(`DELETE FROM tab_credito_anexo WHERE id = @id`, { id });

      Auditoria.registrar(app, {
        modulo: 'Financeiro', submodulo: 'RegistroCredito', acao: 'ANEXO_DELETE', severidade: 'AVISO', req,
        entidade: 'credito_anexo', entidadeId: String(id),
        descricao: `Removeu anexo "${a.titulo}" do registro ${a.registro_id} (sharepoint=${spStatus})`,
        meta: { registro: a.registro_id }
      });

      return res.json({ ok: true, sharepoint: spStatus });
    } catch (err) {
      console.error('financeiro/credito-registro anexo-delete:', err);
      return res.status(500).json({ message: 'Erro ao remover anexo: ' + err.message });
    }
  }
});
