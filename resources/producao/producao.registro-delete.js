// DELETE /producao/registro/:id
// Exclusao TOTAL de um registro de producao:
//   1. Apaga arquivos do SharePoint (anexos com origem='sharepoint')
//   2. DELETE PG cascateia: etapas, anexos (metadata), log de transicoes
//   3. Audita
//
// Idempotente — se o arquivo SP ja sumiu (404), segue. Se algum anexo falhar
// no SP por outro motivo (rede etc), aborta antes do DELETE PG pra nao
// deixar lixo orfao no SharePoint.
//
// Permissao: 14002 (Producao - Admin).

const Graph = require('../../services/graphFiles');
const Auditoria = require('../../services/auditoria');

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([14002]);

module.exports = (app) => ({
  verb: 'delete',
  route: '/registro/:id',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'ID invalido.' });

    try {
      const reg = await Pg.connectAndQuery(
        `SELECT id, op_protheus, produto_codigo, status FROM tab_prod_registro WHERE id = @id`,
        { id }
      );
      if (!reg.length) return res.status(404).json({ message: 'Registro nao encontrado.' });

      // Anexos no SharePoint
      const anexosSp = await Pg.connectAndQuery(
        `SELECT id, sharepoint_drive_id, sharepoint_item_id
           FROM tab_prod_registro_anexo
          WHERE registro_id = @id AND origem = 'sharepoint'
            AND sharepoint_drive_id IS NOT NULL AND sharepoint_item_id IS NOT NULL`,
        { id }
      );

      const spResultado = { apagados: 0, ja_inexistentes: 0, falhas: [] };
      for (const a of anexosSp) {
        try {
          await Graph.deleteFile({ drive_id: a.sharepoint_drive_id, item_id: a.sharepoint_item_id });
          spResultado.apagados++;
        } catch (err) {
          if (err.response?.status === 404) {
            spResultado.ja_inexistentes++;
          } else {
            spResultado.falhas.push({ anexo_id: a.id, erro: err.response?.data?.error?.message || err.message });
          }
        }
      }

      if (spResultado.falhas.length > 0) {
        return res.status(502).json({
          message: 'Falha ao apagar 1+ arquivos do SharePoint. Registro nao foi excluido.',
          sharepoint: spResultado
        });
      }

      // DELETE PG (cascateia etapas, anexos, log via ON DELETE CASCADE)
      await Pg.connectAndQuery(`DELETE FROM tab_prod_registro WHERE id = @id`, { id });

      Auditoria.registrar(app, {
        modulo: 'Producao', submodulo: 'Registro', acao: 'DELETE',
        severidade: 'CRITICO', req,
        entidade: 'prod_registro', entidadeId: id,
        descricao: `Excluiu registro #${id} — OP ${reg[0].op_protheus} (produto ${reg[0].produto_codigo}). ` +
                   `SP: ${spResultado.apagados} arquivos apagados, ${spResultado.ja_inexistentes} ja inexistentes`,
        meta: { op: reg[0].op_protheus, produto: reg[0].produto_codigo, sharepoint: spResultado }
      });

      return res.json({ ok: true, sharepoint: spResultado });
    } catch (err) {
      console.error('Erro producao/registro-delete:', err);
      return res.status(500).json({ message: 'Erro ao excluir registro: ' + err.message });
    }
  }
});
