// POST /integracao/op-sync — roda a sincronizacao OP -> Pipefy agora (manual).
// Perm 1033.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1033]);
const PipefyOp = require('../../services/pipefyOp');
const Auditoria = require('../../services/auditoria');

module.exports = (app) => ({
  verb: 'post',
  route: '/op-sync',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    try {
      const r = await PipefyOp.sincronizar({ Pg, Protheus }, 'MANUAL');
      Auditoria.registrar(app, {
        modulo: 'Tecnologia', submodulo: 'IntegracaoOpPipefy', acao: 'SYNC_MANUAL', severidade: 'INFO', req,
        entidade: 'sync', entidadeId: new Date().toISOString().slice(0, 10),
        descricao: `Sync OP→Pipefy manual: ${r.opsVistas} OPs, ${r.cardsCriados} cards criados, ${r.cardsAtualizados} atualizados, ${r.erros} erros`,
        meta: r
      });
      return res.json(r);
    } catch (err) {
      console.error('Erro op-sync:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
