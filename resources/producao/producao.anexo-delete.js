// Remove um anexo. DELETE /producao/registro/:id/anexo/:anexoId
// Se o anexo for do SharePoint, tenta apagar o arquivo de la primeiro
// (ignora 404 — significa que ja foi apagado fora). PG sempre limpa.

const Graph = require('../../services/graphFiles');
const Auditoria = require('../../services/auditoria');

const checarPerm = async (Pg, idUser) => {
  const r = await Pg.connectAndQuery(
    `SELECT 1 FROM tab_intranet_usr_permissoes WHERE id_user = @id AND id_permissao IN (0, 14001)`,
    { id: idUser }
  );
  return r.length > 0;
};

module.exports = (app) => ({
  verb: 'delete',
  route: '/registro/:id/anexo/:anexoId',

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Nao autenticado.' });
    if (!(await checarPerm(Pg, user.ID))) return res.status(403).json({ message: 'Sem permissao (14001).' });

    const id = Number(req.params.id);
    const anexoId = Number(req.params.anexoId);
    if (!Number.isInteger(id) || !Number.isInteger(anexoId)) {
      return res.status(400).json({ message: 'IDs invalidos.' });
    }

    try {
      const found = await Pg.connectAndQuery(
        `SELECT id, titulo, origem, sharepoint_drive_id, sharepoint_item_id, sharepoint_path
           FROM tab_prod_registro_anexo
          WHERE id = @aid AND registro_id = @rid`,
        { aid: anexoId, rid: id }
      );
      if (!found.length) return res.status(404).json({ message: 'Anexo nao encontrado.' });
      const a = found[0];

      // Apaga do SharePoint se aplicavel. 404 = ja apagado, segue.
      let spStatus = 'nao_aplicavel';
      if (a.origem === 'sharepoint' && a.sharepoint_drive_id && a.sharepoint_item_id) {
        try {
          await Graph.deleteFile({
            drive_id: a.sharepoint_drive_id,
            item_id: a.sharepoint_item_id
          });
          spStatus = 'apagado';
        } catch (err) {
          const code = err.response?.status;
          if (code === 404) {
            spStatus = 'ja_inexistente';
          } else {
            console.error('producao/anexo-delete Graph erro:', err.response?.data || err.message);
            return res.status(502).json({
              message: 'Falha ao apagar do SharePoint: ' + (err.response?.data?.error?.message || err.message)
            });
          }
        }
      }

      await Pg.connectAndQuery(
        `DELETE FROM tab_prod_registro_anexo WHERE id = @aid AND registro_id = @rid`,
        { aid: anexoId, rid: id }
      );

      Auditoria.registrar(app, {
        modulo: 'Producao', submodulo: 'Anexo', acao: 'DELETE',
        severidade: 'AVISO', req,
        entidade: 'prod_registro_anexo', entidadeId: anexoId,
        descricao: `Removeu anexo "${a.titulo}" do registro #${id} (sharepoint=${spStatus})`,
        meta: { origem: a.origem, sharepoint_path: a.sharepoint_path || null }
      });

      return res.json({ ok: true, sharepoint: spStatus });
    } catch (err) {
      console.error('Erro producao/anexo DELETE:', err);
      return res.status(500).json({ message: 'Erro ao remover anexo: ' + err.message });
    }
  }
});
