// PUT /financeiro/pix-baixar/:id — registra que o Pix já foi baixado no Protheus.
//
// NÃO dá baixa: quem baixa é o financeiro, pelo FINA070 (decisão do usuário,
// 30/10). Aqui só guardamos quem conferiu e quando, para o recebimento sair da
// fila e ninguém baixar duas vezes o mesmo Pix.
//
// Permissão 8009.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([8009, 0]);
const Pix = require('../../services/pixCobranca');
const Auditoria = require('../../services/auditoria');

const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'put',
  route: '/pix-baixar/:id',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const user = req.user && req.user[0];
    try {
      const r = await Pix.marcarBaixado(app, {
        id: req.params.id,
        por: user?.id ? Number(user.id) : null,
        obs: trim(req.body?.obs)
      });
      if (r.erro) return res.status(409).json({ message: r.erro });

      Auditoria.registrar(app, {
        modulo: 'Financeiro', submodulo: 'Recebimentos Pix', acao: 'BAIXAR',
        severidade: 'INFO', req, entidade: 'pix', entidade_id: String(r.cobranca.id),
        descricao: `Pix da NF ${trim(r.cobranca.numero)} (R$ ${Number(r.cobranca.valor_pago || 0).toFixed(2)}) marcado como baixado no Protheus`
      });

      return res.json({ ok: true, ...r.cobranca });
    } catch (err) {
      console.error('financeiro/pix-baixar:', err.message);
      return res.status(500).json({ message: 'Erro ao registrar a baixa: ' + err.message });
    }
  }
});
