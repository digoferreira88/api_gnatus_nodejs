// GET /financeiro/boleto-2via — a fila de pedidos de 2ª via que o financeiro atende.
// Perm 8005 (mesma do envio de boleto).
//
//   ?status=aberta|em_atendimento|atendida|recusada   (default: as abertas)
//   ?busca=   nome, documento ou número do título
//
// Traz junto o estado ATUAL do título no espelho: o pedido é de ontem, e entre
// o pedido e o atendimento o cliente pode ter pago.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([8005, 0]);
const Via = require('../../services/boleto2Via');

const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'get',
  route: '/boleto-2via',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const status = trim(req.query.status);
    const busca = trim(req.query.busca);

    const cond = [];
    const p = {};
    if (status) { cond.push('s.status = @status'); p.status = status; }
    else { cond.push('s.status = ANY(@abertas::text[])'); p.abertas = Via.ABERTAS; }
    if (busca) {
      cond.push(`(s.cliente_nome ILIKE @busca OR s.cliente_doc LIKE @doc OR s.numero ILIKE @busca)`);
      p.busca = `%${busca}%`;
      p.doc = `%${busca.replace(/\D/g, '')}%`;
    }

    try {
      const linhas = await Pg.connectAndQuery(
        `SELECT s.id, s.origem, s.ref, s.numero, s.parcela, s.cliente_doc, s.cliente_nome,
                s.vencimento, s.valor, s.saldo, s.dias_atraso, s.contato, s.mensagem,
                s.status, s.resposta, s.novo_vencimento, s.atendido_em, s.criado_em,
                -- estado de agora: entre o pedido e o atendimento o cliente pode ter pago
                e.situacao AS situacao_atual, e.saldo AS saldo_atual,
                e.tem_boleto, e.nosso_numero, e.pode_2via, e.motivo_2via
           FROM tab_boleto_2via_solicitacao s
           LEFT JOIN tab_portal_espelho e ON e.ref = s.ref
          WHERE ${cond.join(' AND ')}
          ORDER BY CASE s.status WHEN 'aberta' THEN 0 WHEN 'em_atendimento' THEN 1 ELSE 2 END,
                   s.criado_em
          LIMIT 300`, p);

      const contagem = await Pg.connectAndQuery(
        `SELECT status, COUNT(*) n FROM tab_boleto_2via_solicitacao GROUP BY status`, {});
      const porStatus = {};
      contagem.forEach(c => { porStatus[trim(c.status)] = Number(c.n); });

      return res.json({
        solicitacoes: linhas,
        por_status: porStatus,
        abertas: (porStatus.aberta || 0) + (porStatus.em_atendimento || 0),
        // Quem já pagou enquanto esperava: a cobrança fecha sem trabalho nenhum.
        pagos_enquanto_esperavam: linhas.filter(l => trim(l.situacao_atual) === 'pago'
          && Via.ABERTAS.includes(trim(l.status))).length
      });
    } catch (err) {
      console.error('financeiro/boleto-2via (fila):', err.message);
      return res.status(500).json({ message: 'Erro ao listar os pedidos: ' + err.message });
    }
  }
});
