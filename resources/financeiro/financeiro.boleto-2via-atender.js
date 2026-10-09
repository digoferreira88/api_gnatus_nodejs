// PUT /financeiro/boleto-2via/:id — anda com o pedido na fila. Perm 8005.
//
//   { status: 'em_atendimento' | 'atendida' | 'recusada' | 'aberta',
//     resposta?, novo_vencimento? }
//
// Fechar (atendida/recusada) exige escrever o que foi feito: sem isso o cliente
// recebe "resolvido" sem saber o quê, e a cobrança perde o histórico de quem
// prorrogou o quê.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([8005, 0]);
const Auditoria = require('../../services/auditoria');
const Via = require('../../services/boleto2Via');

const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'put',
  route: '/boleto-2via/:id',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const id = Number(req.params.id);
    const b = req.body || {};

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ message: 'Pedido inválido.' });
    }

    try {
      const r = await Via.atender(Pg, id, {
        status: trim(b.status),
        resposta: b.resposta,
        novoVencimento: trim(b.novo_vencimento) || null,
        por: user?.id ? Number(user.id) : null
      });
      if (r.erro) return res.status(400).json({ message: r.erro });

      Auditoria.registrar(app, {
        modulo: 'Financeiro', submodulo: '2ª via de boleto', acao: 'EDITAR', severidade: 'INFO',
        req, entidade: 'solicitacao', entidadeId: String(id),
        descricao: `Pedido de 2ª via ${id} (${r.solicitacao.cliente_nome} · ${r.solicitacao.numero}/${r.solicitacao.parcela}): `
          + `${r.de} → ${r.solicitacao.status}`
      });
      return res.json({ ok: true, ...r });
    } catch (err) {
      console.error('financeiro/boleto-2via (atender):', err.message);
      return res.status(500).json({ message: 'Erro ao atualizar o pedido: ' + err.message });
    }
  }
});
