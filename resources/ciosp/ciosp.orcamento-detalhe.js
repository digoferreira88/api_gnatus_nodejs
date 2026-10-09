// GET /ciosp/orcamentos/:uuid — abre um orçamento com itens e trilha. Perm 19001.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([19001, 19002, 0]);
const D = require('../../services/ciospDocs');

module.exports = (app) => ({
  verb: 'get',
  route: '/orcamentos/:uuid',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const uuid = D.trim(req.params.uuid).toLowerCase();

    try {
      const r = await Pg.connectAndQuery(
        `SELECT o.*, p.uuid AS pedido_uuid, p.numero AS pedido_numero
           FROM tab_ciosp_orcamento o
           LEFT JOIN tab_ciosp_pedido p ON p.orcamento_id = o.id
          WHERE o.uuid = @uuid`, { uuid });
      if (!r.length) return res.status(404).json({ message: 'Orçamento não encontrado.' });

      const orcamento = r[0];
      const itens = await D.lerItens(Pg, 'tab_ciosp_orcamento_item', 'orcamento_id', orcamento.id);
      const historico = await Pg.connectAndQuery(
        `SELECT acao, de, para, usuario_id, em FROM tab_ciosp_doc_log
          WHERE documento = 'orcamento' AND documento_id = @id ORDER BY em DESC LIMIT 50`,
        { id: orcamento.id });

      return res.json({ orcamento, itens, historico });
    } catch (err) {
      console.error('ciosp/orcamento-detalhe:', err.message);
      return res.status(500).json({ message: 'Erro ao abrir o orçamento: ' + err.message });
    }
  }
});
