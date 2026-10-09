// POST /financeiro/boleto-2via — abre um pedido de 2ª via. Perm 8005.
//
// Usado pelo próprio financeiro quando o cliente liga (e, quando o portal
// existir, pela ingestão dos pedidos que voltam na resposta da publicação).
//
//   { ref, contato?, mensagem?, origem?, origem_id? }
//
// `ref` é a chave do título no espelho: prefixo|numero|parcela|cliente|loja.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([8005, 0]);
const Auditoria = require('../../services/auditoria');
const Via = require('../../services/boleto2Via');

module.exports = (app) => ({
  verb: 'post',
  route: '/boleto-2via',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const b = req.body || {};

    try {
      const r = await Via.criar(Pg, { ...b, por: user?.id ? Number(user.id) : null });
      if (r.erro) return res.status(400).json({ message: r.erro });
      if (r.jaExistia) {
        return res.status(409).json({
          message: 'Já existe um pedido aberto para esse título.',
          solicitacao: r.solicitacao
        });
      }

      Auditoria.registrar(app, {
        modulo: 'Financeiro', submodulo: '2ª via de boleto', acao: 'CRIAR', severidade: 'INFO',
        req, entidade: 'solicitacao', entidadeId: String(r.solicitacao.id),
        descricao: `Abriu pedido de 2ª via — ${r.solicitacao.cliente_nome} · título ${r.solicitacao.ref}`
      });
      return res.json({ ok: true, ...r });
    } catch (err) {
      console.error('financeiro/boleto-2via (criar):', err.message);
      return res.status(500).json({ message: 'Erro ao abrir o pedido: ' + err.message });
    }
  }
});
