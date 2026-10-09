// GET /ciosp/pedidos/:uuid/contrato — devolve tudo que o contrato impresso precisa.
// Perm 19004 (administração) ou 19002, porque imprimir é passo do processo comercial.
//
// A tela só desenha: o texto das cláusulas, os dados da vendedora e a versão vêm
// daqui (services/ciospContrato.js). Assim o documento que o cliente assina tem uma
// origem só, e dá para saber meses depois qual versão foi impressa.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([19004, 19002, 19001, 0]);
const D = require('../../services/ciospDocs');
const C = require('../../services/ciospContrato');

module.exports = (app) => ({
  verb: 'get',
  route: '/pedidos/:uuid/contrato',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const uuid = D.trim(req.params.uuid).toLowerCase();

    try {
      const r = await Pg.connectAndQuery(
        `SELECT p.*, o.numero AS orcamento_numero FROM tab_ciosp_pedido p
           LEFT JOIN tab_ciosp_orcamento o ON o.id = p.orcamento_id
          WHERE p.uuid = @uuid`, { uuid });
      if (!r.length) return res.status(404).json({ message: 'Pedido não encontrado.' });

      const pedido = r[0];
      const itens = await D.lerItens(Pg, 'tab_ciosp_pedido_item', 'pedido_id', pedido.id);

      return res.json({
        pedido, itens,
        contrato: {
          versao: C.VERSAO,
          vendedora: C.VENDEDORA,
          atencao: C.ATENCAO,
          prazos: C.PRAZOS,
          clausulas: C.CLAUSULAS,
          // O talão é em três vias; o impresso mantém a identificação.
          vias: ['1ª Via Branca – GNATUS', '2ª Via Azul – Cliente', '3ª Via Amarela – Fixa']
        }
      });
    } catch (err) {
      console.error('ciosp/pedido-contrato:', err.message);
      return res.status(500).json({ message: 'Erro ao montar o contrato: ' + err.message });
    }
  }
});
