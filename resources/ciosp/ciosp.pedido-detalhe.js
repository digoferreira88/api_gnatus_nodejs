// GET /ciosp/pedidos/:uuid — abre um pedido com itens, trilha e o cálculo de prazo. Perm 19001.
//
// O prazo de entrega impresso no contrato é uma SOMA, não um chute (quadro 03):
// fabricação do item mais demorado + 2 dias úteis de conferência + 3 de confirmação
// de pagamento + 2 de faturamento e expedição + o transporte. Quem calcula é aqui,
// para a tela e o contrato mostrarem o mesmo número.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([19001, 19002, 0]);
const D = require('../../services/ciospDocs');

// Dias ÚTEIS do quadro 03, somados à fabricação.
const UTEIS_CONFERENCIA = 2, UTEIS_PAGAMENTO = 3, UTEIS_EXPEDICAO = 2;

const somarDiasUteis = (data, dias) => {
  const d = new Date(data);
  let faltam = dias;
  while (faltam > 0) {
    d.setDate(d.getDate() + 1);
    const s = d.getDay();
    if (s !== 0 && s !== 6) faltam--;
  }
  return d;
};

module.exports = (app) => ({
  verb: 'get',
  route: '/pedidos/:uuid',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const uuid = D.trim(req.params.uuid).toLowerCase();

    try {
      const r = await Pg.connectAndQuery(
        `SELECT p.*, o.numero AS orcamento_numero, o.uuid AS orcamento_uuid
           FROM tab_ciosp_pedido p
           LEFT JOIN tab_ciosp_orcamento o ON o.id = p.orcamento_id
          WHERE p.uuid = @uuid`, { uuid });
      if (!r.length) return res.status(404).json({ message: 'Pedido não encontrado.' });

      const pedido = r[0];
      const itens = await D.lerItens(Pg, 'tab_ciosp_pedido_item', 'pedido_id', pedido.id);
      const historico = await Pg.connectAndQuery(
        `SELECT acao, de, para, usuario_id, em FROM tab_ciosp_doc_log
          WHERE documento = 'pedido' AND documento_id = @id ORDER BY em DESC LIMIT 50`,
        { id: pedido.id });

      // Prazo: manda o item de fabricação mais longa (os outros ficam prontos antes).
      const fabricacao = itens.reduce((m, i) => Math.max(m, D.N(i.prazo_fabric)), 0);
      const base = somarDiasUteis(new Date(), UTEIS_CONFERENCIA + UTEIS_PAGAMENTO + UTEIS_EXPEDICAO);
      const transporte = D.N(pedido.prazo_entrega) || D.PRAZO_EXPEDICAO_PADRAO;
      const previsao = new Date(base.getTime() + (fabricacao + transporte) * 86400000);

      return res.json({
        pedido, itens, historico,
        prazo: {
          fabricacao_dias: fabricacao,
          uteis_internos: UTEIS_CONFERENCIA + UTEIS_PAGAMENTO + UTEIS_EXPEDICAO,
          transporte_dias: transporte,
          previsao_entrega: previsao.toISOString().slice(0, 10),
          // Sem prazo de fabricação cadastrado o número é otimista — a tela avisa.
          incompleto: fabricacao === 0
        }
      });
    } catch (err) {
      console.error('ciosp/pedido-detalhe:', err.message);
      return res.status(500).json({ message: 'Erro ao abrir o pedido: ' + err.message });
    }
  }
});
