// GET /integracao/op-sync-status — status da integracao OP -> Pipefy:
// configuracao, ultimas execucoes e ultimas OPs sincronizadas. Perm 1033.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1033]);
const PipefyOp = require('../../services/pipefyOp');
const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'get',
  route: '/op-sync-status',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    try {
      const logs = await Pg.connectAndQuery(
        `SELECT origem, ops_vistas, cards_criados, cards_atualizados, erros, detalhe, executado_em
           FROM tab_op_pipefy_log ORDER BY executado_em DESC LIMIT 10`, {});
      const ops = await Pg.connectAndQuery(
        `SELECT op, numserie, produto, descricao, inicio, fim, id_pipefy, erro, atualizado_em
           FROM tab_op_pipefy_ops ORDER BY atualizado_em DESC LIMIT 20`, {});
      return res.json({
        configurado: PipefyOp.disponivel(),
        tabelaProdutosConfigurada: !!PipefyOp.TABELA_PRODUTOS(),
        pipeId: PipefyOp.PIPE_ID(),
        execucoes: logs.map(l => ({
          origem: trim(l.origem), opsVistas: l.ops_vistas, cardsCriados: l.cards_criados,
          cardsAtualizados: l.cards_atualizados, erros: l.erros, detalhe: l.detalhe || '', em: l.executado_em
        })),
        ops: ops.map(o => ({
          op: trim(o.op), numserie: trim(o.numserie), produto: trim(o.produto), descricao: trim(o.descricao),
          inicio: o.inicio, fim: o.fim, cardId: trim(o.id_pipefy), erro: trim(o.erro), em: o.atualizado_em
        }))
      });
    } catch (err) {
      console.error('Erro op-sync-status:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
