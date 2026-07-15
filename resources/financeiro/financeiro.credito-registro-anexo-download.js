// GET /financeiro/credito-registro/anexo/:id/download — URL temporária de
// download do anexo do registro (SharePoint). Perm 8006. Só anexos de registro.

const Graph = require('../../services/graphFiles');
const Auditoria = require('../../services/auditoria');
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([8006]);

module.exports = (app) => ({
  verb: 'get',
  route: '/credito-registro/anexo/:id/download',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'id inválido.' });

    try {
      const r = await Pg.connectAndQuery(`
        SELECT id, registro_id, titulo, url, sharepoint_drive_id, sharepoint_item_id, nome_original, mime_type, tamanho_bytes
          FROM tab_credito_anexo WHERE id = @id AND registro_id IS NOT NULL`, { id });
      if (!r.length) return res.status(404).json({ message: 'Anexo não encontrado.' });
      const a = r[0];

      let downloadUrl = null;
      if (a.sharepoint_drive_id && a.sharepoint_item_id) {
        try {
          const dl = await Graph.getDownloadUrl({ drive_id: a.sharepoint_drive_id, item_id: a.sharepoint_item_id });
          if (dl.url) downloadUrl = dl.url;
        } catch (err) { console.error('credito-registro/anexo-download Graph:', err.response?.data || err.message); }
      }
      if (!downloadUrl && !a.url) return res.status(502).json({ message: 'Falha ao obter URL do SharePoint.' });

      Auditoria.registrar(app, {
        modulo: 'Financeiro', submodulo: 'RegistroCredito', acao: 'ANEXO_READ', severidade: 'INFO', req,
        entidade: 'credito_anexo', entidadeId: String(a.id),
        descricao: `Baixou anexo "${a.titulo}" do registro ${a.registro_id}`,
        meta: { mime: a.mime_type }
      });

      return res.json({ ok: true, url: downloadUrl || a.url, webUrl: a.url, name: a.nome_original || a.titulo, mime: a.mime_type, size: a.tamanho_bytes });
    } catch (err) {
      console.error('financeiro/credito-registro anexo-download:', err);
      return res.status(500).json({ message: 'Erro ao baixar anexo: ' + err.message });
    }
  }
});
