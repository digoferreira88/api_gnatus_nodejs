// DELETE /producao/instrucoes/:id
// Remove uma instrucao de produto. Apaga do SharePoint primeiro, depois PG.
// Permissao: 14002.

const Graph = require('../../services/graphFiles');
const Auditoria = require('../../services/auditoria');

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([14002]);

module.exports = (app) => ({
  verb: 'delete',
  route: '/instrucoes/:id',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'ID invalido.' });

    try {
      const found = await Pg.connectAndQuery(
        `SELECT id, produto_codigo, etapa_codigo, titulo, sharepoint_drive_id, sharepoint_item_id
           FROM tab_prod_instrucao WHERE id = @id`,
        { id }
      );
      if (!found.length) return res.status(404).json({ message: 'Instrucao nao encontrada.' });
      const i = found[0];

      let spStatus = 'nao_aplicavel';
      if (i.sharepoint_drive_id && i.sharepoint_item_id) {
        try {
          await Graph.deleteFile({ drive_id: i.sharepoint_drive_id, item_id: i.sharepoint_item_id });
          spStatus = 'apagado';
        } catch (err) {
          if (err.response?.status === 404) spStatus = 'ja_inexistente';
          else {
            console.error('producao/instrucoes-delete Graph erro:', err.response?.data || err.message);
            return res.status(502).json({ message: 'Falha ao apagar do SharePoint: ' + (err.response?.data?.error?.message || err.message) });
          }
        }
      }

      await Pg.connectAndQuery(`DELETE FROM tab_prod_instrucao WHERE id = @id`, { id });

      Auditoria.registrar(app, {
        modulo: 'Producao', submodulo: 'Instrucao', acao: 'DELETE',
        severidade: 'AVISO', req,
        entidade: 'prod_instrucao', entidadeId: id,
        descricao: `Removeu instrucao "${i.titulo}" do produto ${i.produto_codigo}` +
                   (i.etapa_codigo ? ` etapa ${i.etapa_codigo}` : ' (geral)'),
        meta: { sharepoint: spStatus }
      });

      return res.json({ ok: true, sharepoint: spStatus });
    } catch (err) {
      console.error('Erro producao/instrucoes-delete:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
