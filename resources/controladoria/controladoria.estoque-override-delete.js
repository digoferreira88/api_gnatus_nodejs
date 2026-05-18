// DELETE /controladoria/estoque-produto-override/:cod
// Limpa TODOS os overrides do produto (volta a usar calculo automatico).
// Permissao 11004.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([11004]);
const Auditoria = require('../../services/auditoria');

module.exports = (app) => ({
  verb: 'delete',
  route: '/estoque-produto-override/:cod',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const cod = String(req.params.cod || '').trim();
    if (!cod) return res.status(400).json({ message: 'codigo obrigatorio.' });

    try {
      const r = await Pg.connectAndQuery(`
        UPDATE tab_estoque_produto_meta
           SET lead_time_override = NULL,
               demanda_mensal_manual = NULL,
               estoque_seguranca_manual = NULL,
               observacao_manual = NULL,
               atualizado_por = @uid,
               manual_em = NOW()
         WHERE cod_produto = @cod
         RETURNING cod_produto`,
        { cod, uid: user.ID }
      );
      if (!r.length) return res.status(404).json({ message: 'Produto nao encontrado.' });

      Auditoria.registrar(app, {
        modulo: 'Controladoria', submodulo: 'EstoqueOverride', acao: 'DELETE',
        severidade: 'AVISO', req,
        entidade: 'estoque_produto_meta', entidadeId: cod,
        descricao: `Removeu parametros manuais do produto ${cod}`
      });

      return res.json({ ok: true });
    } catch (err) {
      console.error('estoque-override-delete:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
