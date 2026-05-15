// GET /producao/instrucao/:id/download
// Retorna { ok, download_url, web_url, name, mime, size } pra UI abrir
// preview SP ou baixar direto. Mesmo padrao de anexo-download.
//
// Permissao: 14001/14002/14003 — operador precisa enxergar pra consultar
// instrucao na execucao.

const Graph = require('../../services/graphFiles');
const Auditoria = require('../../services/auditoria');

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([14001, 14002, 14003]);

module.exports = (app) => ({
  verb: 'get',
  route: '/instrucao/:id/download',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'ID invalido.' });

    try {
      const r = await Pg.connectAndQuery(`
        SELECT id, produto_codigo, etapa_codigo, titulo, web_url,
               sharepoint_drive_id, sharepoint_item_id,
               nome_original, mime_type, tamanho_bytes
          FROM tab_prod_instrucao WHERE id = @id`,
        { id }
      );
      if (!r.length) return res.status(404).json({ message: 'Instrucao nao encontrada.' });
      const i = r[0];

      let download_url = null;
      const web_url = i.web_url || null;
      try {
        const dl = await Graph.getDownloadUrl({
          drive_id: i.sharepoint_drive_id,
          item_id: i.sharepoint_item_id
        });
        if (dl.url) download_url = dl.url;
      } catch (err) {
        console.error('producao/instrucao-download Graph erro:', err.response?.data || err.message);
        if (!web_url) return res.status(502).json({ message: 'Falha SharePoint.' });
      }

      Auditoria.registrar(app, {
        modulo: 'Producao', submodulo: 'Instrucao', acao: 'READ',
        severidade: 'INFO', req,
        entidade: 'prod_instrucao', entidadeId: i.id,
        descricao: `Resolveu URL instrucao "${i.titulo}" (produto ${i.produto_codigo})`,
        meta: { etapa: i.etapa_codigo, mime: i.mime_type, tamanho: i.tamanho_bytes }
      });

      return res.json({
        ok: true,
        download_url, web_url,
        url: download_url || web_url,
        name: i.nome_original || i.titulo,
        mime: i.mime_type, size: i.tamanho_bytes
      });
    } catch (err) {
      console.error('Erro producao/instrucao-download:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
