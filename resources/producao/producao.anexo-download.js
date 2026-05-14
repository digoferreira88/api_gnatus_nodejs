// Download de anexo. GET /producao/anexo/:anexoId/download
//
// Retorna JSON { ok, url, name, mime, size } com URL temporaria de download.
// O front faz window.open(url) ou cria <a download href={url}> pra disparar.
// Motivo: retornar 302 nao funciona bem em SPA com JWT — o browser nao
// inclui Authorization header em redirects subsequentes.
//
// Comportamento:
//   - Anexo origem='sharepoint': resolve URL temporaria via Graph (curta,
//     valida ~1h, sem auth — vai direto do SP pro browser).
//   - Anexo origem='url_externa': retorna a URL armazenada como esta
//     (link manual do anexo-add antigo).
//
// Auditoria registra DOWNLOAD pra rastreabilidade.
// Permissao: 14001 (operar), 14002 (admin) ou 14003 (dashboard) — qualquer um
// que possa abrir o modulo de Producao.

const Graph = require('../../services/graphFiles');
const Auditoria = require('../../services/auditoria');

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([14001, 14002, 14003]);

module.exports = (app) => ({
  verb: 'get',
  route: '/anexo/:anexoId/download',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const anexoId = Number(req.params.anexoId);
    if (!Number.isInteger(anexoId) || anexoId <= 0) {
      return res.status(400).json({ message: 'anexoId invalido.' });
    }

    try {
      const r = await Pg.connectAndQuery(`
        SELECT id, registro_id, titulo, origem, url,
               sharepoint_drive_id, sharepoint_item_id,
               nome_original, mime_type, tamanho_bytes
          FROM tab_prod_registro_anexo
         WHERE id = @id`,
        { id: anexoId }
      );
      if (!r.length) return res.status(404).json({ message: 'Anexo nao encontrado.' });
      const a = r[0];

      let target = a.url;

      if (a.origem === 'sharepoint' && a.sharepoint_drive_id && a.sharepoint_item_id) {
        try {
          const dl = await Graph.getDownloadUrl({
            drive_id: a.sharepoint_drive_id,
            item_id: a.sharepoint_item_id
          });
          if (!dl.url) throw new Error('Graph nao retornou downloadUrl');
          target = dl.url;
        } catch (err) {
          console.error('producao/anexo-download Graph erro:', err.response?.data || err.message);
          // Fallback pra web_url se downloadUrl falhar (vai pedir login no SP)
          if (!a.url) {
            return res.status(502).json({
              message: 'Falha ao obter URL do SharePoint: ' + (err.response?.data?.error?.message || err.message)
            });
          }
        }
      }

      if (!target) return res.status(500).json({ message: 'Anexo sem URL definida.' });

      Auditoria.registrar(app, {
        modulo: 'Producao', submodulo: 'Anexo', acao: 'READ',
        severidade: 'INFO', req,
        entidade: 'prod_registro_anexo', entidadeId: a.id,
        descricao: `Download anexo "${a.titulo}" (registro #${a.registro_id})`,
        meta: { origem: a.origem, mime: a.mime_type, tamanho: a.tamanho_bytes }
      });

      return res.json({
        ok: true,
        url: target,
        name: a.nome_original || a.titulo,
        mime: a.mime_type,
        size: a.tamanho_bytes
      });
    } catch (err) {
      console.error('Erro producao/anexo-download:', err);
      return res.status(500).json({ message: 'Erro ao baixar anexo: ' + err.message });
    }
  }
});
