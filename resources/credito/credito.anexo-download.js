// GET /credito/anexo/:id/download — resolve URL temporária de download do anexo
// (consulta externa) no SharePoint. Retorna JSON { ok, url, name, ... } e o front
// abre com window.open (302 não funciona bem em SPA com JWT). Perm 15100.

const Graph = require('../../services/graphFiles');
const Auditoria = require('../../services/auditoria');

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([15100]);

module.exports = (app) => ({
  verb: 'get',
  route: '/anexo/:id/download',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'id invalido.' });

    try {
      const r = await Pg.connectAndQuery(`
        SELECT id, cliente_cod, cliente_loja, titulo, url,
               sharepoint_drive_id, sharepoint_item_id, nome_original, mime_type, tamanho_bytes
          FROM tab_credito_anexo WHERE id = @id`, { id });
      if (!r.length) return res.status(404).json({ message: 'Anexo nao encontrado.' });
      const a = r[0];

      let download_url = null;
      if (a.sharepoint_drive_id && a.sharepoint_item_id) {
        try {
          const dl = await Graph.getDownloadUrl({ drive_id: a.sharepoint_drive_id, item_id: a.sharepoint_item_id });
          if (dl.url) download_url = dl.url;
        } catch (err) {
          console.error('credito/anexo-download Graph erro:', err.response?.data || err.message);
        }
      }
      if (!download_url && !a.url) return res.status(502).json({ message: 'Falha ao obter URL do SharePoint.' });

      Auditoria.registrar(app, {
        modulo: 'Crédito', submodulo: 'Anexo', acao: 'READ', severidade: 'INFO', req,
        entidade: 'credito_anexo', entidadeId: a.id,
        descricao: `Baixou consulta externa "${a.titulo}" (cliente ${a.cliente_cod}/${a.cliente_loja})`,
        meta: { mime: a.mime_type, tamanho: a.tamanho_bytes }
      });

      return res.json({
        ok: true,
        url: download_url || a.url,     // download direto (temporario) ou preview SP
        web_url: a.url,
        name: a.nome_original || a.titulo,
        mime: a.mime_type,
        size: a.tamanho_bytes
      });
    } catch (err) {
      console.error('Erro credito/anexo-download:', err);
      return res.status(500).json({ message: 'Erro ao baixar anexo: ' + err.message });
    }
  }
});
